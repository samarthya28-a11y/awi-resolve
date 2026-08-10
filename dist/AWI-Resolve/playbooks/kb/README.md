# Knowledge base (searchable product documentation)

The `.json` files here are **generated** — do not edit them by hand. Each one is a
source document (PDF/DOCX/TXT) split into page-tagged chunks so the AI technician
can look things up with the `search_knowledge_base` tool and quote a manual and
page number, instead of a whole manual being stuffed into its context.

## Regenerate / add documentation

```
python tools/ingest-kb.py "<folder with the docs>" --tag <product>
```

Example (the Gespage documentation set):

```
python tools/ingest-kb.py "C:\Users\ASUS\OneDrive - ALPHA WEB INNOVATIONS PRIVATE LIMITED\Gespage" --tag gespage --include "manual|prerequisit|deployment|server_|server |eterminal|cpad|continuity|ports|webservice|agent"
```

`--include` is an optional regex to keep sales/pricing material out of the
technical knowledge base. `--max-mb` skips oversized files. Scanned PDFs with no
text layer are skipped (they would need OCR).

## Notes

- Contents are Alpha Web / Cartadis licensed documentation. This repository is
  **private**; do not publish these files.
- Search runs entirely inside the connector (keyword/TF-IDF). No embeddings, no
  extra API cost, no data leaves the host.
- The Dockerfile copies `playbooks/`, so the knowledge base ships with the cloud
  connector automatically.
