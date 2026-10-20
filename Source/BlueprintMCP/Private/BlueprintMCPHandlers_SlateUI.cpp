#include "BlueprintMCPServer.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"
#include "Widgets/SToolTip.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableText.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Text/ISlateEditableTextWidget.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"

// CLAUDE-NOTE (2026-10-20): ui_find / ui_click let an agent test editor panels (plugin tabs, wizards)
// the way a person would. Posted Windows clicks never reach Slate, so screenshots were the only check
// and every button press needed a human. This walks the live Slate widget tree instead:
//  - roots are top-level windows (matched by title) and dock tabs (matched by label; a tab's content
//    is not under the tab widget, so SDockTab::GetContent() is the root);
//  - a widget counts as visible/enabled only if all of its ancestors are, as Slate itself decides;
//  - a click on a disabled or hidden widget is refused, so a test can't pass where a person couldn't;
//  - SButton::SimulateClick runs the same OnClicked a real click runs (no mouse capture or hover needed),
//    SCheckBox::ToggleCheckedState the same OnCheckStateChanged.
// Only exact SButton / SCheckBox types are clickable; styled subclasses report another type name.
// ui_set_text types into an SEditableText (the inner widget of every text box, search boxes included)
// and fires its OnTextChanged / OnTextCommitted through the public ISlateEditableTextWidget interface:
// SetText alone changes the text without telling the owner (a filter box would not filter).

namespace BlueprintMCPSlateUI
{
	struct FRoot
	{
		FString Kind;   // "window" or "tab"
		FString Name;
		bool bForeground = true;
		TSharedPtr<SWidget> Widget;
	};

	struct FElement
	{
		TSharedPtr<SWidget> Widget;
		FString Root;
		FString Type;
		FString Text;
		FString Row;
		FString ToolTip;
		FString Hint;
		bool bVisible = true;
		bool bEnabled = true;
	};

	static FString OwnText(const TSharedRef<SWidget>& W, const FName& Type)
	{
		if (Type == TEXT("STextBlock")) { return StaticCastSharedRef<STextBlock>(W)->GetText().ToString(); }
		if (Type == TEXT("SEditableText")) { return StaticCastSharedRef<SEditableText>(W)->GetText().ToString(); }
		if (Type == TEXT("SEditableTextBox")) { return StaticCastSharedRef<SEditableTextBox>(W)->GetText().ToString(); }
		return FString();
	}

	static bool IsClickable(const FName& Type)
	{
		return Type == TEXT("SButton") || Type == TEXT("SCheckBox");
	}

	static FString ToolTipText(const TSharedRef<SWidget>& W)
	{
		TSharedPtr<IToolTip> TT = W->GetToolTip();
		if (!TT.IsValid() || TT->IsEmpty() || TT->AsWidget()->GetType() != TEXT("SToolTip")) { return FString(); }
		return StaticCastSharedPtr<SToolTip>(TT)->GetTextTooltip().ToString();
	}

	/** Visible text of W and its visible descendants, joined with " | ". */
	static void GatherText(const TSharedRef<SWidget>& W, TArray<FString>& Out)
	{
		if (!W->GetVisibility().IsVisible()) { return; }
		const FString Own = OwnText(W, W->GetType());
		if (!Own.TrimStartAndEnd().IsEmpty()) { Out.Add(Own.TrimStartAndEnd()); }
		FChildren* Children = W->GetChildren();
		for (int32 i = 0; Children && i < Children->Num(); ++i) { GatherText(Children->GetChildAt(i), Out); }
	}

	static FString JoinedText(const TSharedRef<SWidget>& W)
	{
		TArray<FString> Parts;
		GatherText(W, Parts);
		return FString::Join(Parts, TEXT(" | "));
	}

	static void Walk(const TSharedRef<SWidget>& W, const FString& Root, bool bParentVisible, bool bParentEnabled,
		const FString& Row, const FName& ParentType, bool bIncludeHidden, TSet<const SWidget*>& Seen, TArray<FElement>& Out)
	{
		// A tab's content also sits inside its window: each widget is reported once, under the first root.
		bool bAlreadySeen = false;
		Seen.Add(&W.Get(), &bAlreadySeen);
		if (bAlreadySeen) { return; }
		const bool bVisible = bParentVisible && W->GetVisibility().IsVisible();
		if (!bVisible && !bIncludeHidden) { return; }
		const bool bEnabled = bParentEnabled && W->IsEnabled();
		const FName Type = W->GetType();

		FString ThisRow = Row;
		// A list/tree row is any direct child of the list's SListPanel: custom row classes
		// (SNew(SMyRow)) report their own type name, which need not contain "TableRow".
		if (ParentType == TEXT("SListPanel") || Type.ToString().Contains(TEXT("TableRow"))) { ThisRow = JoinedText(W); }

		const FString Own = OwnText(W, Type);
		const bool bEditable = Type == TEXT("SEditableText");
		if (IsClickable(Type) || bEditable || !Own.TrimStartAndEnd().IsEmpty())
		{
			FElement E;
			E.Widget = W;
			E.Root = Root;
			E.Type = Type.ToString();
			E.Text = IsClickable(Type) ? JoinedText(W) : Own.TrimStartAndEnd();
			E.Row = ThisRow;
			E.ToolTip = ToolTipText(W);
			if (bEditable) { E.Hint = StaticCastSharedRef<SEditableText>(W)->GetHintText().ToString(); }
			E.bVisible = bVisible;
			E.bEnabled = bEnabled;
			Out.Add(E);
		}

		FChildren* Children = W->GetChildren();
		for (int32 i = 0; Children && i < Children->Num(); ++i)
		{
			Walk(Children->GetChildAt(i), Root, bVisible, bEnabled, ThisRow, Type, bIncludeHidden, Seen, Out);
		}
	}

	static void FindTabs(const TSharedRef<SWidget>& W, TArray<TSharedRef<SDockTab>>& Out)
	{
		if (W->GetType() == TEXT("SDockTab")) { Out.Add(StaticCastSharedRef<SDockTab>(W)); }
		FChildren* Children = W->GetChildren();
		for (int32 i = 0; Children && i < Children->Num(); ++i) { FindTabs(Children->GetChildAt(i), Out); }
	}

	static void AllWindows(const TArray<TSharedRef<SWindow>>& In, TArray<TSharedRef<SWindow>>& Out)
	{
		for (const TSharedRef<SWindow>& Win : In)
		{
			Out.Add(Win);
			AllWindows(Win->GetChildWindows(), Out);
		}
	}

	/** Windows whose title contains Filter, and dock tabs whose label contains it. Empty filter = every window. */
	static TArray<FRoot> FindRoots(const FString& Filter)
	{
		TArray<TSharedRef<SWindow>> Windows;
		AllWindows(FSlateApplication::Get().GetTopLevelWindows(), Windows);

		TArray<FRoot> Roots;
		for (const TSharedRef<SWindow>& Win : Windows)
		{
			const FString Title = Win->GetTitle().ToString();
			if (Filter.IsEmpty() || Title.Contains(Filter))
			{
				FRoot R;
				R.Kind = TEXT("window");
				R.Name = Title;
				R.bForeground = Win->IsVisible();
				R.Widget = Win;
				Roots.Add(R);
			}
			if (Filter.IsEmpty()) { continue; }

			TArray<TSharedRef<SDockTab>> Tabs;
			FindTabs(Win, Tabs);
			for (const TSharedRef<SDockTab>& Tab : Tabs)
			{
				const FString Label = Tab->GetTabLabel().ToString();
				if (!Label.Contains(Filter)) { continue; }
				FRoot R;
				R.Kind = TEXT("tab");
				R.Name = Label;
				R.bForeground = Tab->IsForeground();
				R.Widget = Tab->GetContent();
				Roots.Add(R);
			}
		}
		// Tabs first, so their widgets are reported as "tab:<label>" rather than under the window holding them.
		Roots.StableSort([](const FRoot& A, const FRoot& B) { return A.Kind == TEXT("tab") && B.Kind != TEXT("tab"); });
		return Roots;
	}

	static TSharedPtr<FJsonObject> ElementJson(const FElement& E, int32 Index)
	{
		TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetNumberField(TEXT("index"), Index);
		O->SetStringField(TEXT("root"), E.Root);
		O->SetStringField(TEXT("type"), E.Type);
		O->SetStringField(TEXT("text"), E.Text);
		if (!E.Row.IsEmpty() && E.Row != E.Text) { O->SetStringField(TEXT("row"), E.Row); }
		if (!E.ToolTip.IsEmpty()) { O->SetStringField(TEXT("tooltip"), E.ToolTip); }
		if (!E.Hint.IsEmpty()) { O->SetStringField(TEXT("hint"), E.Hint); }
		O->SetBoolField(TEXT("visible"), E.bVisible);
		O->SetBoolField(TEXT("enabled"), E.bEnabled);
		if (E.Type == TEXT("SCheckBox"))
		{
			O->SetBoolField(TEXT("checked"), StaticCastSharedPtr<SCheckBox>(E.Widget)->IsChecked());
		}
		const FGeometry& G = E.Widget->GetTickSpaceGeometry();
		const FVector2D Pos = G.GetAbsolutePosition();
		const FVector2D Size = G.GetAbsoluteSize();
		O->SetNumberField(TEXT("x"), FMath::RoundToInt(Pos.X));
		O->SetNumberField(TEXT("y"), FMath::RoundToInt(Pos.Y));
		O->SetNumberField(TEXT("w"), FMath::RoundToInt(Size.X));
		O->SetNumberField(TEXT("h"), FMath::RoundToInt(Size.Y));
		return O;
	}

	static TArray<TSharedPtr<FJsonValue>> RootsJson(const TArray<FRoot>& Roots)
	{
		TArray<TSharedPtr<FJsonValue>> Arr;
		for (const FRoot& R : Roots)
		{
			TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
			O->SetStringField(TEXT("kind"), R.Kind);
			O->SetStringField(TEXT("name"), R.Name);
			O->SetBoolField(TEXT("foreground"), R.bForeground);
			Arr.Add(MakeShared<FJsonValueObject>(O));
		}
		return Arr;
	}

	static bool Matches(const FElement& E, const FString& Text, bool bExact)
	{
		if (Text.IsEmpty()) { return true; }
		if (bExact) { return E.Text.Equals(Text, ESearchCase::IgnoreCase); }
		return E.Text.Contains(Text) || E.Row.Contains(Text) || E.ToolTip.Contains(Text) || E.Hint.Contains(Text);
	}
}

// ============================================================
// HandleUIFind — list visible text and clickable widgets in editor windows / tabs
// ============================================================

FString FBlueprintMCPServer::HandleUIFind(const FString& Body)
{
	using namespace BlueprintMCPSlateUI;
	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: ui_find()"));

	if (!bIsEditor || !FSlateApplication::IsInitialized())
	{
		return MakeErrorJson(TEXT("ui_find requires the editor UI (not available in commandlet mode)."));
	}

	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	FString RootFilter, Text, Type;
	bool bClickableOnly = false, bIncludeHidden = false;
	int32 Max = 200;
	if (Json.IsValid())
	{
		Json->TryGetStringField(TEXT("root"), RootFilter);
		Json->TryGetStringField(TEXT("text"), Text);
		Json->TryGetStringField(TEXT("type"), Type);
		Json->TryGetBoolField(TEXT("clickableOnly"), bClickableOnly);
		Json->TryGetBoolField(TEXT("includeHidden"), bIncludeHidden);
		Json->TryGetNumberField(TEXT("max"), Max);
	}
	Max = FMath::Clamp(Max, 1, 2000);

	const TArray<FRoot> Roots = FindRoots(RootFilter);
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetArrayField(TEXT("roots"), RootsJson(Roots));
	if (Roots.Num() == 0)
	{
		TArray<TSharedRef<SWindow>> Windows;
		AllWindows(FSlateApplication::Get().GetTopLevelWindows(), Windows);
		TArray<TSharedPtr<FJsonValue>> Titles;
		for (const TSharedRef<SWindow>& Win : Windows) { Titles.Add(MakeShared<FJsonValueString>(Win->GetTitle().ToString())); }
		Result->SetArrayField(TEXT("windowTitles"), Titles);
		Result->SetStringField(TEXT("error"), FString::Printf(TEXT("No window or tab matches '%s'. Open it first, or pick a root from windowTitles."), *RootFilter));
		return JsonToString(Result);
	}

	TArray<FElement> All;
	TSet<const SWidget*> Seen;
	for (const FRoot& R : Roots)
	{
		Walk(R.Widget.ToSharedRef(), R.Kind + TEXT(":") + R.Name, true, true, FString(), NAME_None, bIncludeHidden, Seen, All);
	}

	TArray<TSharedPtr<FJsonValue>> Elements;
	int32 Matched = 0;
	for (const FElement& E : All)
	{
		if (bClickableOnly && !IsClickable(FName(*E.Type))) { continue; }
		if (!Type.IsEmpty() && !E.Type.Equals(Type, ESearchCase::IgnoreCase)) { continue; }
		if (!Matches(E, Text, false)) { continue; }
		if (Matched < Max) { Elements.Add(MakeShared<FJsonValueObject>(ElementJson(E, Matched))); }
		++Matched;
	}
	Result->SetNumberField(TEXT("count"), Matched);
	Result->SetBoolField(TEXT("truncated"), Matched > Max);
	Result->SetArrayField(TEXT("elements"), Elements);
	return JsonToString(Result);
}

// ============================================================
// HandleUIClick — click a button or toggle a checkbox by its label (or its row's text)
// ============================================================

FString FBlueprintMCPServer::HandleUIClick(const FString& Body)
{
	using namespace BlueprintMCPSlateUI;
	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: ui_click()"));

	if (!bIsEditor || !FSlateApplication::IsInitialized())
	{
		return MakeErrorJson(TEXT("ui_click requires the editor UI (not available in commandlet mode)."));
	}

	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) { return MakeErrorJson(TEXT("Invalid JSON body.")); }

	FString RootFilter, Text, Type;
	Json->TryGetStringField(TEXT("root"), RootFilter);
	Json->TryGetStringField(TEXT("type"), Type);
	if (!Json->TryGetStringField(TEXT("text"), Text) || Text.IsEmpty())
	{
		return MakeErrorJson(TEXT("Missing required field: text (the button label, or text in the checkbox's row)."));
	}
	int32 Index = -1;
	Json->TryGetNumberField(TEXT("index"), Index);
	bool bWantChecked = false;
	const bool bHasChecked = Json->TryGetBoolField(TEXT("checked"), bWantChecked);

	const TArray<FRoot> Roots = FindRoots(RootFilter);
	if (Roots.Num() == 0)
	{
		return MakeErrorJson(FString::Printf(TEXT("No window or tab matches '%s'. Use ui_find without root to list window titles."), *RootFilter));
	}

	// Hidden widgets are included so a click on one is refused with a reason instead of "not found".
	TArray<FElement> All;
	TSet<const SWidget*> Seen;
	for (const FRoot& R : Roots)
	{
		Walk(R.Widget.ToSharedRef(), R.Kind + TEXT(":") + R.Name, true, true, FString(), NAME_None, true, Seen, All);
	}
	auto Collect = [&](bool bExact)
	{
		TArray<FElement> Out;
		for (const FElement& E : All)
		{
			if (!IsClickable(FName(*E.Type))) { continue; }
			if (!Type.IsEmpty() && !E.Type.Equals(Type, ESearchCase::IgnoreCase)) { continue; }
			if (Matches(E, Text, bExact)) { Out.Add(E); }
		}
		return Out;
	};
	// Exact label first, so "Stop" doesn't also hit "Stop workload"; then substring of label/row/tooltip.
	TArray<FElement> Hits = Collect(true);
	if (Hits.Num() == 0) { Hits = Collect(false); }
	// Visible ones first: an exact label can also exist on a collapsed copy of the same control.
	Hits.StableSort([](const FElement& A, const FElement& B) { return A.bVisible && !B.bVisible; });

	if (Hits.Num() == 0)
	{
		return MakeErrorJson(FString::Printf(TEXT("No button or checkbox matches '%s'. Use ui_find with clickableOnly=true to see what is there."), *Text));
	}
	if (Hits.Num() > 1 && Index < 0)
	{
		TArray<TSharedPtr<FJsonValue>> Arr;
		for (int32 i = 0; i < Hits.Num() && i < 20; ++i) { Arr.Add(MakeShared<FJsonValueObject>(ElementJson(Hits[i], i))); }
		TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("error"), FString::Printf(TEXT("%d widgets match '%s'. Pass index (0-based, from matches) or a more exact text."), Hits.Num(), *Text));
		Result->SetArrayField(TEXT("matches"), Arr);
		return JsonToString(Result);
	}
	if (Index < 0) { Index = 0; }
	if (Index >= Hits.Num()) { return MakeErrorJson(FString::Printf(TEXT("index %d is out of range (%d matches)."), Index, Hits.Num())); }

	const FElement& E = Hits[Index];
	if (!E.bVisible) { return MakeErrorJson(FString::Printf(TEXT("'%s' is hidden, so a person couldn't click it either."), *E.Text)); }
	if (!E.bEnabled) { return MakeErrorJson(FString::Printf(TEXT("'%s' is disabled (greyed out), so a person couldn't click it either."), *E.Text)); }

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetObjectField(TEXT("widget"), ElementJson(E, Index));
	if (E.Type == TEXT("SButton"))
	{
		StaticCastSharedPtr<SButton>(E.Widget)->SimulateClick();
		Result->SetStringField(TEXT("action"), TEXT("clicked"));
	}
	else
	{
		TSharedPtr<SCheckBox> Box = StaticCastSharedPtr<SCheckBox>(E.Widget);
		const bool bBefore = Box->IsChecked();
		if (!bHasChecked || bBefore != bWantChecked) { Box->ToggleCheckedState(); }
		Result->SetStringField(TEXT("action"), bHasChecked && bBefore == bWantChecked ? TEXT("unchanged") : TEXT("toggled"));
		Result->SetBoolField(TEXT("checkedBefore"), bBefore);
		Result->SetBoolField(TEXT("checkedAfter"), Box->IsChecked());
	}
	Result->SetBoolField(TEXT("success"), true);
	return JsonToString(Result);
}

// ============================================================
// HandleUISetText — type into a text box (found by its hint, current text, tooltip or row)
// ============================================================

FString FBlueprintMCPServer::HandleUISetText(const FString& Body)
{
	using namespace BlueprintMCPSlateUI;
	UE_LOG(LogTemp, Display, TEXT("BlueprintMCP: ui_set_text()"));

	if (!bIsEditor || !FSlateApplication::IsInitialized())
	{
		return MakeErrorJson(TEXT("ui_set_text requires the editor UI (not available in commandlet mode)."));
	}

	TSharedPtr<FJsonObject> Json = ParseBodyJson(Body);
	if (!Json.IsValid()) { return MakeErrorJson(TEXT("Invalid JSON body.")); }

	FString RootFilter, Target, NewText;
	Json->TryGetStringField(TEXT("root"), RootFilter);
	Json->TryGetStringField(TEXT("target"), Target);
	if (!Json->TryGetStringField(TEXT("text"), NewText))
	{
		return MakeErrorJson(TEXT("Missing required field: text (what to type; empty string clears the box)."));
	}
	int32 Index = -1;
	Json->TryGetNumberField(TEXT("index"), Index);
	bool bCommit = true;
	Json->TryGetBoolField(TEXT("commit"), bCommit);

	const TArray<FRoot> Roots = FindRoots(RootFilter);
	if (Roots.Num() == 0)
	{
		return MakeErrorJson(FString::Printf(TEXT("No window or tab matches '%s'. Use ui_find without root to list window titles."), *RootFilter));
	}

	TArray<FElement> All;
	TSet<const SWidget*> Seen;
	for (const FRoot& R : Roots)
	{
		Walk(R.Widget.ToSharedRef(), R.Kind + TEXT(":") + R.Name, true, true, FString(), NAME_None, true, Seen, All);
	}
	TArray<FElement> Hits;
	for (const FElement& E : All)
	{
		if (E.Type == TEXT("SEditableText") && Matches(E, Target, false)) { Hits.Add(E); }
	}
	Hits.StableSort([](const FElement& A, const FElement& B) { return A.bVisible && !B.bVisible; });

	if (Hits.Num() == 0)
	{
		return MakeErrorJson(FString::Printf(TEXT("No text box matches '%s'. Use ui_find with type='SEditableText' to see the boxes and their hints."), *Target));
	}
	if (Hits.Num() > 1 && Index < 0)
	{
		TArray<TSharedPtr<FJsonValue>> Arr;
		for (int32 i = 0; i < Hits.Num() && i < 20; ++i) { Arr.Add(MakeShared<FJsonValueObject>(ElementJson(Hits[i], i))); }
		TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("error"), FString::Printf(TEXT("%d text boxes match '%s'. Pass index (0-based, from matches) or a target from the box's hint."), Hits.Num(), *Target));
		Result->SetArrayField(TEXT("matches"), Arr);
		return JsonToString(Result);
	}
	if (Index < 0) { Index = 0; }
	if (Index >= Hits.Num()) { return MakeErrorJson(FString::Printf(TEXT("index %d is out of range (%d matches)."), Index, Hits.Num())); }

	const FElement& E = Hits[Index];
	if (!E.bVisible) { return MakeErrorJson(TEXT("That text box is hidden, so a person couldn't type in it either.")); }
	if (!E.bEnabled) { return MakeErrorJson(TEXT("That text box is disabled, so a person couldn't type in it either.")); }

	TSharedPtr<SEditableText> Box = StaticCastSharedPtr<SEditableText>(E.Widget);
	if (Box->IsTextReadOnly()) { return MakeErrorJson(TEXT("That text box is read-only.")); }
	const FString Before = Box->GetText().ToString();
	const FText Value = FText::FromString(NewText);
	Box->SetText(Value);
	ISlateEditableTextWidget& Editable = *Box;
	Editable.OnTextChanged(Value);
	if (bCommit) { Editable.OnTextCommitted(Value, ETextCommit::OnEnter); }

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), true);
	Result->SetObjectField(TEXT("widget"), ElementJson(E, Index));
	Result->SetStringField(TEXT("before"), Before);
	Result->SetStringField(TEXT("after"), Box->GetText().ToString());
	Result->SetBoolField(TEXT("committed"), bCommit);
	return JsonToString(Result);
}
