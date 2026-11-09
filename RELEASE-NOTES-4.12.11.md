# 4.12.11

Privacy cleanup only.

- Removed hardcoded `C:\Users\<name>` paths from development bin scripts.
- Hugging Face cache paths now use `HF_HOME` or `os.homedir()`.
- Memory fixture scripts use `--dir` / `CONTINUITY_FIXTURE_DIR` and
  `CONTINUITY_EMBEDDINGS` instead of a developer's local backup path.
- Replaced the example path in `test/extraction-provider.test.mjs`.

No runtime behavior change.
