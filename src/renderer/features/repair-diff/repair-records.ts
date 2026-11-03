import type {
  ProcessingResult,
  RepairChange,
  RepairStage,
} from "../../../shared/types";

export interface RepairRecordChange extends RepairChange {
  origin: "source" | "extracted";
}

export interface RepairRecordStage extends RepairStage {
  origin: "source" | "extracted";
  changes: RepairRecordChange[];
}

export function getRepairSummary(
  result?: ProcessingResult,
  preparation?: ProcessingResult,
): { stageCount: number; changeCount: number | null } {
  let stageCount = 0;
  let changeCount: number | null = 0;
  const include = (part: ProcessingResult | undefined) => {
    if (!part) return;
    stageCount += part.stages.length;
    if (part.stages.length && part.changeCount === null) changeCount = null;
    for (const stage of part.stages) {
      if (stage.diffTruncated) changeCount = null;
      else if (changeCount !== null) changeCount += stage.changes.length;
    }
  };
  include(preparation);
  include(result);
  return { stageCount, changeCount };
}

export function collectRepairRecords(
  result?: ProcessingResult,
  preparation?: ProcessingResult,
): {
  stages: RepairRecordStage[];
  changes: RepairRecordChange[];
  changeCount: number | null;
  sourceDecodedLayers: number;
} {
  const stages: RepairRecordStage[] = [];
  const changes: RepairRecordChange[] = [];
  const include = (
    part: ProcessingResult | undefined,
    origin: RepairRecordStage["origin"],
  ) => {
    if (!part) return;
    for (const stage of part.stages) {
      const id = preparation ? `${origin}:${stage.id}` : stage.id;
      const stageChanges = stage.changes.map((change) => ({
        ...change,
        id: preparation ? `${origin}:${change.id}` : change.id,
        stageId: preparation ? id : change.stageId,
        origin,
      }));
      stages.push({ ...stage, id, origin, changes: stageChanges });
      changes.push(...stageChanges);
    }
  };
  include(preparation, "source");
  include(result, preparation ? "extracted" : "source");
  return {
    stages,
    changes,
    changeCount: getRepairSummary(result, preparation).changeCount,
    sourceDecodedLayers: preparation?.decodedLayers ?? 0,
  };
}
