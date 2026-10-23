import type { InspectionRecord } from "../domain/inspection";

export interface Journal {
  append(record: InspectionRecord): Promise<{ recordId: string }>;
}
