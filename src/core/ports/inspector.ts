import type { InspectionAsset, InspectionReport } from "../domain/inspection";
import type { Journal } from "./journal";

export interface Inspector {
  inspect(
    asset: InspectionAsset,
    journal: Journal,
  ): Promise<InspectionReport>;
}
