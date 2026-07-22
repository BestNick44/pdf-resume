export interface BookRecord {
  title: string;
  customTitle: string | null;
  totalPages: number;
  currentPage: number;
  scrollTop: number;
  addedAt: number;
  lastReadAt: number;
}

export interface ViewerHighWaterMark {
  effectiveTime: number;
  sequence: number;
}

export interface PositionWinner {
  effectiveTime: number;
  viewerId: string | null;
  sequence: number;
}

export interface PositionOrderEntry {
  version: 2;
  generation: string;
  winner: PositionWinner | null;
  viewers: Record<string, ViewerHighWaterMark>;
}

export interface PositionObservation {
  viewerId: string;
  sequence: number;
  observedAt: number;
}

export interface Position {
  currentPage: number;
  scrollTop: number;
}

export type StorageMutationStatus = "updated" | "stale" | "missing" | "invalid";

export type ClientResultStatus = StorageMutationStatus | "failed";

export interface UpdatePositionMessage {
  type: "pdf-resume/private/update-position";
  fileUrl: string;
  position: Position;
  observation: PositionObservation;
  trackingGeneration: string;
}

export interface PendingPositionHandoffMessage {
  type: "pdf-resume/private/handoff-pending-position";
  fileUrl: string;
  position: Position;
  observation: PositionObservation;
}
