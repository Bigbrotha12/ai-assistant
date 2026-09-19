import 'package:dio/dio.dart';

import 'plugin_dto.dart';
import 'plugin_http.dart';

class PluginRegistryClient {
  PluginRegistryClient({
    required this.dio,
    required String baseUrl,
    Duration timeout = const Duration(seconds: 20),
  }) : _http = PluginHttp(dio: dio, baseUrl: baseUrl, timeout: timeout),
       _baseUrl = baseUrl.replaceFirst(RegExp(r'/+$'), '');

  final Dio dio;
  final PluginHttp _http;
  final String _baseUrl;

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

  Future<List<AgentDto>> listAgents({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _get('/agents', gatewayKey, cancelToken, AgentDto.parseList);

  Future<List<Map<String, dynamic>>> fetchSkills({
    required String gatewayKey,
  }) async {
    final response = await dio.get(
      '$_baseUrl/skills',
      options: Options(headers: {'Authorization': 'Bearer $gatewayKey'}),
    );
    final body = response.data as Map<String, dynamic>;
    return (body['data'] as List<dynamic>).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> fetchMcps({
    required String gatewayKey,
  }) async {
    final response = await dio.get(
      '$_baseUrl/mcps',
      options: Options(headers: {'Authorization': 'Bearer $gatewayKey'}),
    );
    final body = response.data as Map<String, dynamic>;
    return (body['data'] as List<dynamic>).cast<Map<String, dynamic>>();
  }

  /// Returns the list of agent templates (redacted — no systemPrompt/skills content).
  Future<List<Map<String, dynamic>>> fetchAgentTemplates({
    required String gatewayKey,
  }) async {
    final response = await dio.get(
      '$_baseUrl/agents',
      options: Options(headers: {'Authorization': 'Bearer $gatewayKey'}),
    );
    final body = response.data as Map<String, dynamic>;
    return (body['data'] as List<dynamic>).cast<Map<String, dynamic>>();
  }

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
