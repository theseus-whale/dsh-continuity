# Model provenance and distribution decision

## Upstream project

- Project: FlagOpen/FlagEmbedding
- Source: https://github.com/FlagOpen/FlagEmbedding
- License: MIT
- License text: `LICENSE-FlagEmbedding-MIT.txt`
- Upstream LICENSE blob: https://api.github.com/repos/FlagOpen/FlagEmbedding/license
- Copyright notice in upstream LICENSE: Copyright (c) 2022 staoxiao

## Upstream model

- Model: BAAI/bge-small-zh-v1.5
- Hugging Face: https://huggingface.co/BAAI/bge-small-zh-v1.5
- ModelScope: https://www.modelscope.cn/models/BAAI/bge-small-zh-v1.5

## Xenova conversion evidence

- Converter repository: https://huggingface.co/Xenova/bge-small-zh-v1.5
- Official metadata revision: `75c43b069aac4d136ba6bc1122f995fedcfd2781`
- Last modified: `2025-07-22T16:45:56.000Z`
- Quantized ONNX: 24,010,842 bytes
- Quantized ONNX SHA-256: `15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc`
- The locally used artifact had the same SHA-256.

Official metadata was read through the Hugging Face API mirror. The model card has no license declaration and the API tags contain no license tag. The upstream MIT statement alone is not treated here as conversion-specific redistribution clearance.

## Distribution decision

The production npm package does not include the model files. Users must provide their own local `Xenova/bge-small-zh-v1.5` directory before enabling memory embeddings. See `docs/MODEL.md` and `INSTALL.md`.

This decision resolves the package's bundled-model release blocker without asserting that redistribution is known to be unlawful.
