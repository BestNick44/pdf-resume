export interface BookRecord {
  title: string;
  customTitle: string | null;
  totalPages: number;
  currentPage: number;
  scrollTop: number;
  addedAt: number;
  lastReadAt: number;
}

export interface BookWithCompletion {
  book: BookRecord;
  completedAt: number | null;
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

export interface PositionObservationMetadata {
  viewerId: string;
  sequence: number;
  observedAt: number;
}

export interface RegisteredPositionObservation
  extends PositionObservationMetadata {
  intent: "registered";
  trackingGeneration: string;
}

export interface PendingPositionObservation extends PositionObservationMetadata {
  intent: "pending";
}

export type PositionObservation =
  | RegisteredPositionObservation
  | PendingPositionObservation;

export interface Position {
  currentPage: number;
  scrollTop: number;
}

export type StorageMutationStatus = "updated" | "stale" | "missing" | "invalid";

export type ClientResultStatus = StorageMutationStatus | "failed";

export interface RecordObservationMessage {
  type: "pdf-resume/private/record-observation";
  fileUrl: string;
  position: Position;
  observation: PositionObservation;
}
