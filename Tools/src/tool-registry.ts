import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerReadTools } from "./tools/read.js";
import { registerMutationTools } from "./tools/mutation.js";
import { registerVariableTools } from "./tools/variables.js";
import { registerParamTools } from "./tools/params.js";
import { registerGraphTools } from "./tools/graphs.js";
import { registerBuildGraphTools } from "./tools/build-graph.js";
import { registerInterfaceTools } from "./tools/interfaces.js";
import { registerDispatcherTools } from "./tools/dispatchers.js";
import { registerComponentTools } from "./tools/components.js";
import { registerSnapshotTools } from "./tools/snapshot.js";
import { registerValidationTools } from "./tools/validation.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerDiffBlueprintsTools } from "./tools/diff-blueprints.js";
import { registerUserTypeTools } from "./tools/user-types.js";
import { registerMaterialReadTools } from "./tools/material-read.js";
import { registerMaterialMutationTools } from "./tools/material-mutation.js";
import { registerAnimationTools } from "./tools/animation-mutation.js";
import { registerLevelActorTools } from "./tools/level-actors.js";
import { registerActorQueryTools } from "./tools/actor-query.js";
import { registerSpatialTools } from "./tools/spatial.js";
import { registerCameraTools } from "./tools/camera.js";
import { registerViewModeTools } from "./tools/view-mode.js";
import { registerPIERuntimeTools } from "./tools/pie-runtime.js";
import { registerSublevelTools } from "./tools/sublevels.js";
import { registerEditorUtilityTools } from "./tools/editor-utils.js";
import { registerSelectionTools } from "./tools/selection.js";
import { registerCVarTools } from "./tools/cvars.js";
import { registerOutputLogTools } from "./tools/output-log.js";
import { registerScreenshotTools } from "./tools/screenshot.js";
import { registerPIELifecycleTools } from "./tools/pie-lifecycle.js";
import { registerContentBrowserTools } from "./tools/content-browser.js";
import { registerUndoRedoTools } from "./tools/undo-redo.js";
import { registerWidgetTools } from "./tools/widgets.js";
import { registerLevelTools } from "./tools/level.js";
import { registerNiagaraTools } from "./tools/niagara.js";
import { registerRunPythonTools } from "./tools/run-python.js";
import { registerDiscoverPythonTools } from "./tools/discover-python.js";
import { registerGroomTools } from "./tools/groom.js";
import { registerMirrorTableTools } from "./tools/mirror-table.js";
import { registerPcgTools } from "./tools/pcg.js";
import { registerPcgAuthoringTools } from "./tools/pcg-authoring.js";
import { registerDataAssetTools } from "./tools/data-assets.js";
import { registerProfilingTools } from "./tools/profiling.js";
import { registerVisionTools } from "./tools/vision.js";

// CLAUDE-NOTE: single source of truth for "every tool-registration function + a human-friendly
// category label", consumed by index.ts (real registration), batch-schema-invariant.test.ts
// (schema auditing), and agent-config.ts (capability-reference generation). Before this existed,
// the same ~40-line import/call list was independently maintained in two places (index.ts and the
// test file) — exactly the kind of silent-drift risk route-parity.test.ts exists to catch for HTTP
// routes. Add new tool files here, not directly in index.ts.
export interface ToolRegistration {
  register: (server: McpServer) => void;
  category: string;
}

export const TOOL_REGISTRATIONS: ToolRegistration[] = [
  { register: registerReadTools, category: "Blueprint Read" },
  { register: registerMutationTools, category: "Blueprint Mutation" },
  { register: registerVariableTools, category: "Blueprint Variables" },
  { register: registerParamTools, category: "Blueprint Function Params" },
  { register: registerGraphTools, category: "Blueprint Graphs" },
  { register: registerBuildGraphTools, category: "Blueprint Graph Batch-Build" },
  { register: registerInterfaceTools, category: "Blueprint Interfaces" },
  { register: registerDispatcherTools, category: "Blueprint Event Dispatchers" },
  { register: registerComponentTools, category: "Blueprint Components" },
  { register: registerSnapshotTools, category: "Graph Snapshot/Diff/Restore" },
  { register: registerValidationTools, category: "Blueprint Validation" },
  { register: registerUtilityTools, category: "Asset Utility" },
  { register: registerDiscoveryTools, category: "Class/Type Discovery" },
  { register: registerDiffBlueprintsTools, category: "Blueprint Diff" },
  { register: registerUserTypeTools, category: "Structs/Enums" },
  { register: registerMaterialReadTools, category: "Material Read" },
  { register: registerMaterialMutationTools, category: "Material Mutation" },
  { register: registerAnimationTools, category: "Animation Blueprints" },
  { register: registerLevelActorTools, category: "Level Actor Mutation" },
  { register: registerActorQueryTools, category: "Level Actor Query" },
  { register: registerSpatialTools, category: "Spatial Queries" },
  { register: registerCameraTools, category: "Viewport Camera" },
  { register: registerViewModeTools, category: "Viewport View Mode" },
  { register: registerPIERuntimeTools, category: "PIE Runtime" },
  { register: registerSublevelTools, category: "Sublevels" },
  { register: registerEditorUtilityTools, category: "Editor Utility" },
  { register: registerSelectionTools, category: "Editor Selection" },
  { register: registerCVarTools, category: "Console Variables" },
  { register: registerOutputLogTools, category: "Output Log" },
  { register: registerScreenshotTools, category: "Screenshots" },
  { register: registerPIELifecycleTools, category: "PIE Lifecycle" },
  { register: registerContentBrowserTools, category: "Content Browser" },
  { register: registerUndoRedoTools, category: "Undo/Redo" },
  { register: registerWidgetTools, category: "UMG Widgets" },
  { register: registerLevelTools, category: "Level Management" },
  { register: registerNiagaraTools, category: "Niagara" },
  { register: registerRunPythonTools, category: "Python Bridge" },
  { register: registerDiscoverPythonTools, category: "Python API Discovery" },
  { register: registerGroomTools, category: "Groom" },
  { register: registerMirrorTableTools, category: "Mirror Data Tables" },
  { register: registerPcgTools, category: "PCG" },
  { register: registerPcgAuthoringTools, category: "PCG Authoring" },
  { register: registerDataAssetTools, category: "Asset Creation" },
  { register: registerProfilingTools, category: "Profiling" },
  { register: registerVisionTools, category: "Vision" },
];
