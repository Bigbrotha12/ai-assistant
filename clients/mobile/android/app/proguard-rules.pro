# No app-specific R8 rules are currently required. The sherpa-onnx runtime is
# loaded via dart:ffi from its bundled .so libraries and has no Java API
# surface to keep. (The previous ai.onnxruntime keep rule belonged to the
# removed flutter_onnxruntime plugin.)
