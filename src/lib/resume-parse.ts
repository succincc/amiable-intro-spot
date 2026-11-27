/** Browser-side resume text extraction (PDF via pdfjs-dist, DOCX via jszip). */

/** Below this many characters the file is almost certainly a scan with no text layer. */
export const MIN_RESUME_CHARS = 200;

export function docxXmlToText(xml: string): string {
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function looksScanned(text: string) {
  return text.trim().length < MIN_RESUME_CHARS;
}

export async function extractResumeText(file: File): Promise<string> {
  return cleanResumeText(await readResumeFile(file));
}

async function readResumeFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || file.type === "text/plain") return (await file.text()).trim();
  if (name.endsWith(".docx")) {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const doc = zip.file("word/document.xml");
    if (!doc) throw new Error("This .docx has no document body.");
    return docxXmlToText(await doc.async("string"));
  }
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join(""));
    }
    return pages.join("\n").replace(/[ \t]+\n/g, "\n").trim();
  }
  throw new Error("Upload a .pdf, .docx or .txt file.");
}

/**
 * A resume's text as a person would have typed it.
 *
 * What comes out of a PDF is the page's drawing order: a bullet on a line of
 * its own with its sentence on the next, columns joined by a run of spaces,
 * characters no keyboard has. One of those — a null character — is refused
 * outright by the database ("unsupported Unicode escape sequence"), which is
 * how an upload came to fail with nothing saved. So:
 *
 *   - characters that are not text are taken out;
 *   - a bullet is put back on the line it belongs to, and a bullet with
 *     nothing after it is dropped;
 *   - a wide gap between two things on a line becomes " | ", which is what
 *     it meant: a title and a place, an employer and its dates;
 *   - runs of blank lines are one blank line.
 */
export function cleanResumeText(raw: string | null | undefined): string {
  const BULLET = "[•●▪◦■□➢➤►▸∙⋅·\\uf0b7\\uf0a7\\u2023\\u25e6]";
  const lines = String(raw ?? "")
    // Not text: nulls and the other control characters, and halves of a pair with no partner.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2000-\u200a\u202f\u3000]/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .split("\n")
    .map((l) => l.replace(/\t/g, "   ").replace(/\s+$/g, ""));
  const out: string[] = [];
  const alone = new RegExp(`^\\s*${BULLET}\\s*$`);
  const starts = new RegExp(`^\\s*${BULLET}\\s*`);
  let strays = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (alone.test(line)) {
      // A run of bullets with nothing beside them is the page's bullet marks
      // read out on their own; the line after the run is not one of theirs.
      const run = strays || (i + 1 < lines.length && alone.test(lines[i + 1]!));
      strays = true;
      if (run) continue;
      // The sentence is on the next line that has one; a bullet followed by
      // another bullet, or by nothing, was only ever a mark on the page.
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim()) j++;
      if (j < lines.length && !starts.test(lines[j]!) && lines[j]!.trim().length > 2 && j - i <= 2) {
        line = `• ${lines[j]!.trim()}`;
        i = j;
      } else continue;
      strays = false;
    } else if (starts.test(line)) {
      strays = false;
      line = `• ${line.replace(starts, "").trim()}`;
    }
    else strays = false;
    line = line.replace(/^\s+/, "").replace(/ {3,}/g, " | ").replace(/ {2}/g, " ");
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
