# Local embedding model prerequisite

The production package does **not** include Xenova model weights or tokenizer files. Enablement requires a user-supplied local copy of `Xenova/bge-small-zh-v1.5`.

Set `embeddingModel` in each enabled private overlay to the **absolute directory** containing:

```text
config.json
tokenizer.json
tokenizer_config.json
onnx/model_quantized.onnx
```

Example (a placeholder, not a packaged path):

```json
{
  "embeddingModel": "<absolute-local-model-directory>"
}
```

The embedder fails before model execution when the path is not local or any required file is missing. It does not silently substitute a remote model ID. BGE embedding remains local after the directory is supplied.

## Why the model is not bundled

The upstream FlagEmbedding/BAAI MIT evidence is preserved in the source workspace, but the Xenova conversion repository's model card does not declare a license and its official API metadata has no license tag. That is insufficient conversion-specific redistribution evidence for this package. This is a conservative distribution choice, not a claim that redistribution is known to be unlawful.

## Verified artifact identity

Official model metadata was read through the Hugging Face API mirror on 2026-11-18:

```text
repository: Xenova/bge-small-zh-v1.5
revision: 75c43b069aac4d136ba6bc1122f995fedcfd2781
lastModified: 2025-07-22T16:45:56.000Z
model_quantized.onnx bytes: 24010842
model_quantized.onnx SHA-256: 15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc
```

That SHA-256 exactly matches the artifact previously used in the local installation. Source: https://huggingface.co/api/models/Xenova/bge-small-zh-v1.5?blobs=true

Users remain responsible for reviewing the model's upstream terms when obtaining their own copy.
