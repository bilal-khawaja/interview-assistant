import { MEDIA_TYPES } from "../constants/media";
import { InspectionService } from "../core/services/inspection-service";
import { Journal } from "../infra/console/journal";
import { AssetStore } from "../infra/local/asset-store";
import { Inspector } from "../infra/mastra/inspector";
import { PdfReader } from "../infra/pdfjs/pdf-reader";

export function createInspection() {
  return new InspectionService(
    new AssetStore(),
    new PdfReader(),
    new Inspector(),
    new Journal(),
    MEDIA_TYPES,
  );
}
