# Intelligence evaluation contract

Prompt or model changes are not release-ready on unit tests alone. Run `npm run eval:intelligence` against a private, versioned gold set with `SECOND_BRAIN_GOLD_PATH` set. The evaluator deliberately exits non-zero when the gold set is absent; missing private evaluation can never look like a pass.

Gold cases may cover exact identity ownership, positive and negative project classification, item actor/type/status/evidence, clarification internalization, and required or forbidden top-ten attention items. Keep personal names and communication excerpts outside Git. Store stable database IDs or deidentified fixture IDs, review failures rather than weakening the threshold, and bump the gold version whenever the expected decision changes.

The release order is: source/canonical audit, private evaluation, tests/build, API/UI smoke, then deployment. Any model fallback must satisfy the same structured-output and evidence-validation contract as the preferred model.
