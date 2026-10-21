export type InspectionAsset = {
  path: string;
  data: Uint8Array;
  mediaType: string;
  extractedText?: string;
};

export type InspectionUrgency = "low" | "medium" | "high";

export type InspectionRecord = {
  summary: string;
  urgency: InspectionUrgency;
};

export type InspectionFindings = {
  detectedObjects: string[];
  isCorrupted: boolean;
  confidenceScore: number;
};

export type InspectionReport = {
  narrative: string;
  findings: InspectionFindings;
};
