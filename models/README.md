# Bundled embedding model

- Model: `Xenova/bge-small-zh-v1.5`
- Files: `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx`
- Runtime: `@huggingface/transformers` (ONNX/WASM)
- Intent: offline facet extraction; no text leaves the machine.

The plugin loads this directory via `env.localModelPath` and disables remote
model downloads when `config.json` is present. If the model is removed, the
loader falls back to the local HF cache / configured mirror.

Model weights retain their upstream license; this directory only packages the
quantized artifacts for offline use.
