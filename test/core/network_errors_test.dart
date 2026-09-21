import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/network_errors.dart';

DioException _badResponse(Object? data, int statusCode) => DioException(
      requestOptions: RequestOptions(path: '/x'),
      response: Response(
        requestOptions: RequestOptions(path: '/x'),
        statusCode: statusCode,
        data: data,
      ),
      type: DioExceptionType.badResponse,
    );

DioException _network(DioExceptionType type) => DioException(
      requestOptions: RequestOptions(path: '/x'),
      type: type,
    );

void main() {
  group('describeDioError', () {
    test('badResponse with null body renders just HTTP code (never : null)',
        () {
      expect(describeDioError(_badResponse(null, 500)), 'HTTP 500');
      expect(describeDioError(_badResponse('', 500)), 'HTTP 500');
    });

    test('badResponse prefers the server "message" over the raw map', () {
      expect(
        describeDioError(
          _badResponse({'message': 'Invalid email or password'}, 401),
        ),
        'HTTP 401: Invalid email or password',
      );
    });

    test('badResponse tolerates an outer error wrapper', () {
      expect(
        describeDioError(
          _badResponse({
            'error': {'message': 'Server is busy'},
          }, 503),
        ),
        'HTTP 503: Server is busy',
      );
    });

    test('badResponse falls back to a plain string body', () {
      expect(describeDioError(_badResponse('boom', 502)), 'HTTP 502: boom');
    });

    test('network failures and cancellation keep their stable copy', () {
      expect(
        describeDioError(_network(DioExceptionType.connectionError)),
        'unreachable',
      );
      expect(
        describeDioError(_network(DioExceptionType.receiveTimeout)),
        'unreachable',
      );
      expect(describeDioError(_network(DioExceptionType.cancel)), 'cancelled');
    });
  });
}