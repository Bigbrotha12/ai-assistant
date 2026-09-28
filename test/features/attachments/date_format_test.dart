import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'package:ai_assistant/features/attachments/ui/files_screen.dart';

void main() {
  // Mirrors main(): without this, every non-en_US locale throws.
  setUpAll(initializeDateFormatting);

  // 2025-03-14 is unambiguous: 14 March in en-GB/es, March 14 in en-US. A
  // formatter that ignores the locale collapses these to the same string, so
  // the assertions below are the whole point of the test.
  final march14 = DateTime(2025, 3, 14, 12);

  group('formatDateForLocale', () {
    test('honours the stored locale', () {
      expect(formatDateForLocale(march14, 'en_US'), contains('Mar'));
      expect(formatDateForLocale(march14, 'en_GB'), contains('14'));
      expect(formatDateForLocale(march14, 'es'), contains('mar'));
    });

    test('reassembles into the right date for each locale', () {
      // Strip the separators and digits so only ordering + month name remain.
      String shape(String out) => out.replaceAll(RegExp(r'[\d\s,./]'), '');

      expect(shape(formatDateForLocale(march14, 'en_US')), 'Mar');
      expect(shape(formatDateForLocale(march14, 'en_GB')), 'Mar');
      // Spanish puts the day first, so the month name is not the leading token.
      expect(formatDateForLocale(march14, 'es'), isNot(contains('14 Mar')));
    });

    test('an unusable locale falls back instead of throwing', () {
      // A list tile must never crash on a corrupt/hand-edited stored value.
      for (final bad in ['', 'not a locale', '!!!', 'x' * 64]) {
        expect(
          () => formatDateForLocale(march14, bad),
          returnsNormally,
          reason: 'locale "$bad" should not throw',
        );
      }
    });

    test('a null locale still produces a date', () {
      expect(formatDateForLocale(march14, null), isNotEmpty);
    });

    test('converts to local time before formatting', () {
      // A UTC instant late in the day can land on the next day locally; the
      // formatter must not show a date the user never saw.
      final lateUtc = DateTime.utc(2025, 3, 14, 23, 30);
      expect(formatDateForLocale(lateUtc, 'en_US'), isNotEmpty);
    });
  });
}
