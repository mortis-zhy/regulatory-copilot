# Enterprise KB v2 integration boundary

The platform deliberately treats document intelligence as an adapter, not as a UI concern. `server/ingestion/pipeline.ts` accepts a document reference and returns normalized blocks with stable keys, hierarchy, page anchors, confidence and parsing warnings.

## Suggested production flow

1. Upload the original file to controlled object storage and create a `regulatory_documents` row with an immutable fingerprint.
2. Submit the file reference to the enterprise document service. MinerU can handle layout-aware extraction; RAG-Anything can add multimodal handling for tables, figures and equations.
3. Persist the normalized blocks as `regulatory_clauses`, retaining the original page and bounding-box anchors.
4. Run structure alignment before content diff. Preserve one-to-one, one-to-many, many-to-one and no-match relations in `clause_mappings`.
5. Extract parameters and evidence into separate records. Do not flatten numeric values, units, conditions and exceptions into a single summary string.
6. Send low-confidence parsing, mapping and high-impact changes to the review queue.
7. Freeze a report only after evidence and review gates pass.

## Deployment assumptions

The referenced repository describes a Python 3.12 service, PostgreSQL with pgvector, Redis, S3-compatible storage and model endpoints. The current WebDev app keeps the product workflow in Node/TypeScript. A production deployment should connect to that service over an authenticated HTTP boundary or deploy the parser service alongside the app where the hosting environment permits it.

Credentials, uploaded documents, model endpoints and runtime logs must remain outside source control. The adapter is intentionally endpoint-based so the integration can be tested with a mock service before connecting a production parser.
