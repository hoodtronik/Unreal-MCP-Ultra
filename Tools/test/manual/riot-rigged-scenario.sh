#!/usr/bin/env bash
# Re-authors the rigged-representation acceptance scenario against a running editor on port 9847.
#
# CLAUDE-NOTE: this exists because scenario persistence is deferred by explicit owner decision -
# everything Riot Crowd holds is in-process, so every editor restart loses the authored scenario and
# every profile. Re-running this script IS the reproduction path. It was a session scratchpad file
# during the milestone; it is committed so a human reviewer can reproduce the acceptance runs
# without reverse-engineering them from the test record.
#
# Asset paths are the Third Person template assets as they land in the disposable RiotRiggedTest
# project (see RIOT-RIGGED-REPRESENTATION-TEST-RECORD.md). They are project content, NOT plugin
# content - the plugin ships no characters, which is the milestone's hard requirement.
#
# The scenario is anchored around the Lvl_ThirdPerson play area: the player spawns at the origin,
# so the blockade sits 1,500uu in front (+X) and the crowd flows in from 5,000-9,000uu out. Ground
# height is # Ground height and level. Default: the flat Lvl_RiotProxy authored for this milestone
# (user call: a flat plane beats the template level, whose raised platform floated agents over the
# void and whose walls occluded ground contact in captures). Override for other levels:
#   RIOT_Z=214 RIOT_WORLD=Lvl_ThirdPerson bash riot-rigged-scenario.sh
Z=${RIOT_Z:-0}
WORLD=${RIOT_WORLD:-Lvl_RiotProxy}. Anchoring matters: the first evidence pass authored the crowd at arbitrary
# coordinates and photographed a perfectly valid empty field.
#
# Usage:  bash riot-rigged-scenario.sh [rioterCount] [defenderCount]
set -u
B=http://localhost:9847/api
M=/Game/Characters/Mannequins
A=$M/Anims/Unarmed
# Ground height and level. Default: the flat Lvl_RiotProxy authored for this milestone
# (user call: a flat plane beats the template level, whose raised platform floated agents over the
# void and whose walls occluded ground contact in captures). Override for other levels:
#   RIOT_Z=214 RIOT_WORLD=Lvl_ThirdPerson bash riot-rigged-scenario.sh
Z=${RIOT_Z:-0}
WORLD=${RIOT_WORLD:-Lvl_RiotProxy}

RIOTERS=${1:-210}
DEFENDERS=${2:-34}
PER_ORIGIN=$(( RIOTERS / 3 ))
LAST_ORIGIN=$(( RIOTERS - 2 * PER_ORIGIN ))

post() {
  curl -s -m 120 -X POST "$B/$1" -H "Content-Type: application/json" -d "$2" \
  | python -c "import sys,json
d=json.load(sys.stdin)
print(('OK   ' if d.get('success') else 'FAIL ')+(d.get('summary') or (str(d.get('errorCode'))+': '+str(d.get('error'))[:110])))"
}

# ----- character profiles (idempotent: already-exists failures are fine on re-run) -----
post riot-register-character-profile "{\"profileId\":\"rioter_manny\",\"displayName\":\"Rioter - Manny\",\"factionTypes\":[\"rioter\"],\"selectionWeight\":2.0,\"skeletalMeshPath\":\"$M/Meshes/SKM_Manny_Simple.SKM_Manny_Simple\",\"skeletonPath\":\"$M/Meshes/SK_Mannequin.SK_Mannequin\",\"animationSet\":[{\"slot\":\"idle\",\"animationPath\":\"$A/MM_Idle.MM_Idle\"},{\"slot\":\"advancing\",\"animationPath\":\"$A/Walk/MF_Unarmed_Walk_Fwd.MF_Unarmed_Walk_Fwd\",\"referenceSpeed\":200},{\"slot\":\"advancing\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"referenceSpeed\":375,\"minSpeed\":280},{\"slot\":\"pressuring\",\"animationPath\":\"$A/Attack/MM_Attack_01.MM_Attack_01\"},{\"slot\":\"breaching\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"referenceSpeed\":375},{\"slot\":\"panicked\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"playRate\":1.3,\"referenceSpeed\":375},{\"slot\":\"retreating\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"playRate\":1.15,\"referenceSpeed\":375}]}"
post riot-register-character-profile "{\"profileId\":\"rioter_quinn\",\"displayName\":\"Rioter - Quinn\",\"factionTypes\":[\"rioter\"],\"selectionWeight\":2.0,\"skeletalMeshPath\":\"$M/Meshes/SKM_Quinn_Simple.SKM_Quinn_Simple\",\"skeletonPath\":\"$M/Meshes/SK_Mannequin.SK_Mannequin\",\"animationSet\":[{\"slot\":\"idle\",\"animationPath\":\"$A/MM_Idle.MM_Idle\"},{\"slot\":\"advancing\",\"animationPath\":\"$A/Walk/MF_Unarmed_Walk_Fwd.MF_Unarmed_Walk_Fwd\",\"referenceSpeed\":200},{\"slot\":\"advancing\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"referenceSpeed\":375,\"minSpeed\":280},{\"slot\":\"pressuring\",\"animationPath\":\"$A/Attack/MM_Attack_02.MM_Attack_02\"},{\"slot\":\"breaching\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"referenceSpeed\":375},{\"slot\":\"panicked\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"playRate\":1.25,\"referenceSpeed\":375},{\"slot\":\"retreating\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"playRate\":1.15,\"referenceSpeed\":375}]}"
post riot-register-character-profile "{\"profileId\":\"rioter_agitator\",\"displayName\":\"Rioter - Agitator\",\"factionTypes\":[\"rioter\"],\"selectionWeight\":1.0,\"skeletalMeshPath\":\"$M/Meshes/SKM_Quinn_Simple.SKM_Quinn_Simple\",\"skeletonPath\":\"$M/Meshes/SK_Mannequin.SK_Mannequin\",\"animationSet\":[{\"slot\":\"idle\",\"animationPath\":\"$A/MM_Idle.MM_Idle\",\"playRate\":1.15},{\"slot\":\"gathering\",\"animationPath\":\"$A/Attack/MM_ChargedAttack.MM_ChargedAttack\"},{\"slot\":\"advancing\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"referenceSpeed\":375},{\"slot\":\"pressuring\",\"animationPath\":\"$A/Attack/MM_Attack_03.MM_Attack_03\"},{\"slot\":\"breaching\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"playRate\":1.2,\"referenceSpeed\":375},{\"slot\":\"panicked\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"playRate\":1.35,\"referenceSpeed\":375},{\"slot\":\"retreating\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"playRate\":1.15,\"referenceSpeed\":375}]}"
post riot-register-character-profile "{\"profileId\":\"defender_manny\",\"displayName\":\"Defender - Manny\",\"factionTypes\":[\"police\"],\"selectionWeight\":1.0,\"skeletalMeshPath\":\"$M/Meshes/SKM_Manny_Simple.SKM_Manny_Simple\",\"skeletonPath\":\"$M/Meshes/SK_Mannequin.SK_Mannequin\",\"animationSet\":[{\"slot\":\"idle\",\"animationPath\":\"$A/MM_Idle.MM_Idle\"},{\"slot\":\"holding\",\"animationPath\":\"$A/MM_Idle.MM_Idle\"},{\"slot\":\"bracing\",\"animationPath\":\"$A/Attack/MM_ChargedAttack.MM_ChargedAttack\"},{\"slot\":\"advancing\",\"animationPath\":\"$A/Walk/MF_Unarmed_Walk_Fwd.MF_Unarmed_Walk_Fwd\",\"referenceSpeed\":200},{\"slot\":\"advancing\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"referenceSpeed\":375,\"minSpeed\":280},{\"slot\":\"fallback\",\"animationPath\":\"$A/Walk/MF_Unarmed_Walk_Bwd.MF_Unarmed_Walk_Bwd\",\"referenceSpeed\":200},{\"slot\":\"broken\",\"animationPath\":\"$M/Anims/Death/MM_Death_Front_01.MM_Death_Front_01\",\"looping\":false}]}"
post riot-register-character-profile "{\"profileId\":\"defender_quinn\",\"displayName\":\"Defender - Quinn\",\"factionTypes\":[\"police\"],\"selectionWeight\":1.0,\"skeletalMeshPath\":\"$M/Meshes/SKM_Quinn_Simple.SKM_Quinn_Simple\",\"skeletonPath\":\"$M/Meshes/SK_Mannequin.SK_Mannequin\",\"animationSet\":[{\"slot\":\"idle\",\"animationPath\":\"$A/MM_Idle.MM_Idle\"},{\"slot\":\"holding\",\"animationPath\":\"$A/MM_Idle.MM_Idle\",\"playRate\":0.95},{\"slot\":\"bracing\",\"animationPath\":\"$A/Attack/MM_Attack_01.MM_Attack_01\"},{\"slot\":\"advancing\",\"animationPath\":\"$A/Walk/MF_Unarmed_Walk_Fwd.MF_Unarmed_Walk_Fwd\",\"referenceSpeed\":200},{\"slot\":\"advancing\",\"animationPath\":\"$A/Jog/MF_Unarmed_Jog_Fwd.MF_Unarmed_Jog_Fwd\",\"referenceSpeed\":375,\"minSpeed\":280},{\"slot\":\"fallback\",\"animationPath\":\"$A/Walk/MF_Unarmed_Walk_Bwd.MF_Unarmed_Walk_Bwd\",\"referenceSpeed\":200},{\"slot\":\"broken\",\"animationPath\":\"$M/Anims/Death/MM_Death_Back_01.MM_Death_Back_01\",\"looping\":false}]}"

# ----- scenario (delete-then-create so counts can change between runs) -----
post riot-delete-scenario '{"scenarioId":"rigged_intersection"}'
post riot-create-scenario '{"scenarioId":"rigged_intersection","displayName":"Rigged city intersection","seed":20260728,"world":"Lvl_ThirdPerson"}'
post riot-add-faction "{\"scenarioId\":\"rigged_intersection\",\"factionId\":\"crowd\",\"type\":\"rioter\",\"maxSpawnCount\":$((RIOTERS+100))}"
post riot-add-faction "{\"scenarioId\":\"rigged_intersection\",\"factionId\":\"line\",\"type\":\"police\",\"maxSpawnCount\":$((DEFENDERS+20))}"
post riot-add-flow-origin "{\"scenarioId\":\"rigged_intersection\",\"originId\":\"far\",\"factionId\":\"crowd\",\"location\":{\"x\":9000,\"y\":0,\"z\":$Z},\"initialTarget\":{\"x\":1500,\"y\":0,\"z\":$Z},\"spawnRadius\":900,\"spawnCount\":$PER_ORIGIN,\"spawnDelay\":0,\"spawnInterval\":0.02,\"speedMin\":180,\"speedMax\":420}"
post riot-add-flow-origin "{\"scenarioId\":\"rigged_intersection\",\"originId\":\"mid_l\",\"factionId\":\"crowd\",\"location\":{\"x\":5200,\"y\":-1800,\"z\":$Z},\"initialTarget\":{\"x\":1500,\"y\":0,\"z\":$Z},\"spawnRadius\":800,\"spawnCount\":$PER_ORIGIN,\"spawnDelay\":0.3,\"spawnInterval\":0.02,\"speedMin\":180,\"speedMax\":420}"
post riot-add-flow-origin "{\"scenarioId\":\"rigged_intersection\",\"originId\":\"mid_r\",\"factionId\":\"crowd\",\"location\":{\"x\":5200,\"y\":1800,\"z\":$Z},\"initialTarget\":{\"x\":1500,\"y\":0,\"z\":$Z},\"spawnRadius\":800,\"spawnCount\":$LAST_ORIGIN,\"spawnDelay\":0.6,\"spawnInterval\":0.02,\"speedMin\":180,\"speedMax\":420}"
post riot-add-blockade "{\"scenarioId\":\"rigged_intersection\",\"blockadeId\":\"main_line\",\"defendingFactionId\":\"line\",\"location\":{\"x\":1500,\"y\":0,\"z\":$Z},\"yawDegrees\":180,\"width\":1800,\"depth\":200,\"defenderCount\":$DEFENDERS,\"holdThreshold\":40,\"breakThreshold\":100,\"fallbackLocation\":{\"x\":300,\"y\":0,\"z\":$Z},\"fallbackSpeed\":220}"
post riot-set-trigger '{"scenarioId":"rigged_intersection","triggerId":"breach","type":"Breach","condition":"PressureThreshold","targetBlockadeId":"main_line","thresholdValue":100}'
post riot-set-trigger '{"scenarioId":"rigged_intersection","triggerId":"panic","type":"Panic","condition":"AgentsPassed","thresholdValue":40,"affectedFraction":0.5}'
post riot-assign-character-profiles '{"scenarioId":"rigged_intersection","factionId":"crowd","profileIds":["rioter_manny","rioter_quinn","rioter_agitator"]}'
post riot-assign-character-profiles '{"scenarioId":"rigged_intersection","factionId":"line","profileIds":["defender_manny","defender_quinn"]}'
post riot-set-representation-profile '{"profileId":"rep_default","scenarioId":"rigged_intersection","nearDistance":1500,"midDistance":4000,"farDistance":14000,"hysteresisDistance":300,"maxNearActors":24,"maxMidRepresentations":200,"cameraSource":"piePlayerCamera"}'

echo "scenario authored: $RIOTERS rioters + $DEFENDERS defenders (seed 20260728)"
