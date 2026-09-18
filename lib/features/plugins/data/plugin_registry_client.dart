import 'package:dio/dio.dart';

import 'plugin_dto.dart';
import 'plugin_http.dart';

class PluginRegistryClient {
  PluginRegistryClient({
    required Dio dio,
    required String baseUrl,
    Duration timeout = const Duration(seconds: 20),
  }) : _http = PluginHttp(dio: dio, baseUrl: baseUrl, timeout: timeout);

  final PluginHttp _http;

  Future<List<PluginDto>> listPlugins({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _get('/plugins', gatewayKey, cancelToken, PluginDto.parseList);

  Future<PluginDto> getPlugin(
    String id, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) {
    pluginJsonId(id);
    return _get(
      '/plugins/$id',
      gatewayKey,
      cancelToken,
      PluginDto.fromDetailJson,
    );
  }

  Future<List<PluginModelDto>> listModels({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _get('/models', gatewayKey, cancelToken, PluginModelDto.parseList);

  Future<T> _get<T>(
    String path,
    String key,
    CancelToken? token,
    T Function(Object?) parse,
  ) => _http.run(token, (localToken) async {
    final response = await _http.send(
      path: path,
      gatewayKey: key,
      cancelToken: localToken,
    );
    return parse(await _http.readJson(response.data));
  });
}
