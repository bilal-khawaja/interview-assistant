import type { InspectionRecord } from "../../core/domain/inspection";
import type * as Port from "../../core/ports";

export class Journal implements Port.Journal {
  async append(record: InspectionRecord): Promise<{ recordId: string }> {
    const recordId = `REC-${Math.floor(Math.random() * 10000)}`;
    console.log(
      `\n[Inspection journal] ${recordId} urgency=${record.urgency} summary="${record.summary}"`,
    );
    return { recordId };
  }
}
