import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Shared [Dio] instance for every HTTP client, so they share one connection
/// pool and (future) interceptors.
final dioProvider = Provider<Dio>((ref) => Dio());
