import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type * as Port from "../../core/ports";

const STANDARD_FONT_DATA_URL =
  join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + "/";

function normalizePageText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class PdfReader implements Port.PdfReader {
  async read(pdfPath: string): Promise<Port.PdfContent> {
    const fileBytes = await readFile(pdfPath);
    const loadingTask = getDocument({
      data: new Uint8Array(fileBytes),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      useWorkerFetch: false,
    });

    try {
      const document = await loadingTask.promise;
      const pages: string[] = [];

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        pages.push(normalizePageText(text));
      }

      if (pages.every((page) => page.length === 0)) {
        throw new Error(
          `No extractable text was found in ${pdfPath}. If this is a scanned PDF, OCR is required before the LLM can explain it.`,
        );
      }

      return {
        pageCount: document.numPages,
        pages,
        text: pages
          .map(
            (page, index) =>
              `[Page ${index + 1}]\n${page || "[No extractable text]"}`,
          )
          .join("\n\n"),
      };
    } finally {
      await loadingTask.destroy();
    }
  }
}
