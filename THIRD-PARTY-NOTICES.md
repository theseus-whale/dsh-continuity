# Third-party notices

## Bundled embedding model

```text
Model: Xenova/bge-small-zh-v1.5
Files: config.json, tokenizer.json, tokenizer_config.json,
       onnx/model_quantized.onnx
Runtime: @huggingface/transformers (ONNX/WASM)
```

The model weights retain their upstream license. This repository packages the
quantized artifacts for offline use; it does not relicense the weights.

Upstream model card:

```text
https://huggingface.co/Xenova/bge-small-zh-v1.5
```

## Runtime dependencies

The plugin declares DSH/Cordis packages as peer dependencies. They are provided
by the DeepSeek Harness installation, not bundled here. Their licenses remain
with their respective authors.

## Code

The plugin source in this repository is MIT-licensed; see `LICENSE`.
