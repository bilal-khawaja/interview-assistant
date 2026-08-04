import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export interface FileAttachment {
  name: string;
  mimeType: string;
  data: string;
}

const MAX_EXTRACTED_CHARS = 50_000;

function truncate(text: string): string {
  return text.length > MAX_EXTRACTED_CHARS
    ? `${text.slice(0, MAX_EXTRACTED_CHARS)}\n\n[...truncated]`
    : text;
}

async function extractOne(attachment: FileAttachment): Promise<string> {
  const buffer = Buffer.from(attachment.data, 'base64');
  const name = attachment.name.toLowerCase();

  if (name.endsWith('.pdf') || attachment.mimeType === 'application/pdf') {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    return result.text;
  }

  if (name.endsWith('.docx') || attachment.mimeType.includes('wordprocessingml')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls') || attachment.mimeType.includes('spreadsheetml')) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return `# Sheet: ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet)}`;
    }).join('\n\n');
  }

  if (name.endsWith('.txt') || name.endsWith('.md') || attachment.mimeType.startsWith('text/')) {
    return buffer.toString('utf-8');
  }

  throw new Error(`Unsupported file type: ${attachment.name}`);
}

export async function extractAttachmentsText(attachments: FileAttachment[]): Promise<string> {
  const parts = await Promise.all(
    attachments.map(async (attachment) => {
      try {
        const text = await extractOne(attachment);
        return `--- File: ${attachment.name} ---\n${truncate(text.trim())}`;
      } catch (error) {
        return `--- File: ${attachment.name} ---\n[Failed to extract: ${error instanceof Error ? error.message : String(error)}]`;
      }
    })
  );
  return parts.join('\n\n');
}
