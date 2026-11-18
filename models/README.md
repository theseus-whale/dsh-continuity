# Model source workspace

This directory is retained for provenance only. Model files are **not included in the production npm package**.

The local runtime requires a user-supplied `Xenova/bge-small-zh-v1.5` directory containing `config.json`, `tokenizer.json`, `tokenizer_config.json` and `onnx/model_quantized.onnx`. See `docs/MODEL.md` for the required layout and verified artifact identity.

`NOTICE.md` records upstream sources and the conservative decision not to redistribute the quantized conversion with the package.
