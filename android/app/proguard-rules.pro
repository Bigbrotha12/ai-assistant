# flutter_onnxruntime reaches the ONNX Runtime Java API (ai.onnxruntime.*)
# through JNI, so R8 cannot see those references and would strip the classes
# during release minification. Keep them.
-keep class ai.onnxruntime.** { *; }
