"""
Use RAGAnything's MineruParser directly.
"""
import sys
import json
from pathlib import Path

def main():
    pdf_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not pdf_path:
        print("Usage: python rag_parse.py <pdf>")
        return

    from raganything.parser import MineruParser

    parser = MineruParser()
    out_dir = Path("./rag_storage") / Path(pdf_path).stem
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Parsing {pdf_path} → {out_dir}")

    # parse_pdf returns (content_list, md_content)
    content_list, md_content = parser.parse_pdf(
        pdf_path=pdf_path,
        output_dir=str(out_dir),
        method="txt",
    )
    print(f"Got {len(content_list)} blocks, markdown {len(md_content)} chars")

    (out_dir / "full.md").write_text(md_content, encoding="utf-8")
    (out_dir / "blocks.json").write_text(
        json.dumps(content_list, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Saved to {out_dir}/full.md and blocks.json")

main()
