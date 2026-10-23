export type PdfContent = {
  pageCount: number;
  pages: string[];
  text: string;
};

export interface PdfReader {
  read(pdfPath: string): Promise<PdfContent>;
}
