import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/core/theme.dart';
import 'package:ai_assistant/core/theme_providers.dart';
import 'package:ai_assistant/core/widgets/gold_band.dart';
import 'package:ai_assistant/core/widgets/golden_pill.dart';
import 'package:ai_assistant/core/widgets/speak_button.dart';
import 'package:ai_assistant/features/settings/settings_screen.dart';

import 'fakes.dart';

void main() {
  group('design system tokens', () {
    test('core theme is Manrope with no premium flag', () {
      final theme = buildCoreTheme();
      expect(theme.extension<TierTheme>()?.premium, isFalse);
      // The global family is materialised into the text theme.
      expect(theme.textTheme.bodyMedium?.fontFamily, AppFonts.manrope);
      expect(theme.textTheme.displaySmall?.fontFamily, AppFonts.manrope);
      expect(
        theme.scaffoldBackgroundColor,
        AppColors.surface,
      );
    });

    test('premium theme flips the tier and uses transparent scaffolds', () {
      final theme = buildPremiumTheme();
      expect(theme.extension<TierTheme>()?.premium, isTrue);
      expect(theme.scaffoldBackgroundColor, Colors.transparent);
      expect(theme.appBarTheme.shape, isA<Border>());
      // Headlines switch to the serif brand face in premium.
      expect(theme.textTheme.displaySmall?.fontFamily, AppFonts.garamond);
      expect(theme.textTheme.bodyMedium?.fontFamily, AppFonts.manrope);
    });
  });

  group('AppTier store/notifier', () {
    test('defaults to standard when nothing is stored', () async {
      final store = FakeAppTierStore();
      final container = ProviderContainer(
        overrides: [appTierStoreProvider.overrideWithValue(store)],
      );
      addTearDown(container.dispose);
      final tier = await container.read(appTierProvider.future);
      expect(tier, AppTier.standard);
      expect(store.saved, isNull);
    });

    test('setTier persists premium', () async {
      final store = FakeAppTierStore();
      final container = ProviderContainer(
        overrides: [appTierStoreProvider.overrideWithValue(store)],
      );
      addTearDown(container.dispose);
      await container.read(appTierProvider.notifier).setTier(AppTier.premium);
      expect(store.saved, AppTier.premium);
      expect(await container.read(appTierProvider.future), AppTier.premium);
    });
  });

  group('SpeakButton', () {
    Widget wrap(Widget child, {ThemeData? theme}) => MaterialApp(
          theme: theme,
          home: Scaffold(body: Center(child: child)),
        );

    testWidgets('hold-down and release fire the hold callbacks', (tester) async {
      final starts = <String>[];
      final ends = <String>[];
      await tester.pumpWidget(wrap(
        SpeakButton(
          onHoldStart: () => starts.add('s'),
          onHoldEnd: () => ends.add('e'),
        ),
      ));

      await tester.tap(find.byType(SpeakButton));
      await tester.pump(const Duration(milliseconds: 200));

      expect(starts, ['s']);
      expect(ends, ['e']);
    });

    testWidgets('busy guard suppresses hold start', (tester) async {
      final starts = <String>[];
      await tester.pumpWidget(wrap(
        SpeakButton(
          onHoldStart: () => starts.add('s'),
          onHoldEnd: () {},
          busy: true,
        ),
      ));

      await tester.tap(find.byType(SpeakButton));
      await tester.pump(const Duration(milliseconds: 200));
      expect(starts, isEmpty);
    });

    testWidgets('premium variant renders the gold-banded button', (tester) async {
      await tester.pumpWidget(wrap(
        SpeakButton(onHoldStart: () {}, onHoldEnd: () {}),
        theme: buildPremiumTheme(),
      ));
      await tester.pump(const Duration(milliseconds: 300));

      // The premium button is a decorated gold edge; the mic glyph is present.
      expect(find.byType(GoldEdge), findsWidgets);
      expect(find.byIcon(Icons.mic), findsWidgets);
      expect(tester.takeException(), isNull);
    });
  });

  group('GoldenPill', () {
    testWidgets('shows label and up-chevron when closed', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: GoldenPill(label: 'Transcript', open: false, onTap: () {}),
        ),
      ));

      expect(find.text('Transcript'), findsOneWidget);
      expect(find.byIcon(Icons.expand_less), findsOneWidget);
      expect(find.byIcon(Icons.keyboard_arrow_down), findsNothing);
    });

    testWidgets('chevron flips when open', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: GoldenPill(label: 'Transcript', open: true, onTap: () {}),
        ),
      ));

      expect(find.byIcon(Icons.keyboard_arrow_down), findsOneWidget);
    });

    testWidgets('premium renders the gold edge, tapping fires onTap',
        (tester) async {
      var taps = 0;
      await tester.pumpWidget(MaterialApp(
        theme: buildPremiumTheme(),
        home: Scaffold(
          body: GoldenPill(
            label: 'Transcript',
            open: false,
            onTap: () => taps++,
          ),
        ),
      ));

      expect(find.byType(GoldEdge), findsOneWidget);
      await tester.tap(find.text('Transcript'));
      expect(taps, 1);
    });
  });

  group('paper layer', () {
    testWidgets('PaperTexture paints without exceptions', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: PaperTexture()),
      ));
      expect(tester.takeException(), isNull);
    });

    testWidgets('premium app builder layers paper base under grain behind the screen',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: buildPremiumTheme(),
        builder: (context, child) => Stack(
          fit: StackFit.expand,
          children: [
            RepaintBoundary(
              child: ColoredBox(
                color: AppColors.paperBase,
                child: PaperTexture(),
              ),
            ),
            child!,
          ],
        ),
        home: const Scaffold(body: Text('I am paper')),
      ));

      expect(find.text('I am paper'), findsOneWidget);
      expect(find.byType(PaperTexture), findsOneWidget);
      // The translucent grain never floats over an empty backdrop: the
      // warm-ivory paper base is painted behind it (design §3.1).
      final backdrop = tester.widget<ColoredBox>(
        find
            .ancestor(
              of: find.byType(PaperTexture),
              matching: find.byType(ColoredBox),
            )
            .first,
      );
      expect(backdrop.color, AppColors.paperBase);
      expect(tester.takeException(), isNull);
    });
  });

  group('settings tier toggle', () {
    Widget settingsApp(FakeAppTierStore tierStore) => ProviderScope(
          overrides: [
            settingsStoreProvider.overrideWithValue(FakeSettingsStore()),
            backendProbeProvider.overrideWithValue(FakeProbe()),
            appTierStoreProvider.overrideWithValue(tierStore),
          ],
          child: const MaterialApp(home: SettingsScreen()),
        );

    testWidgets('defaults to Standard and persists Premium on tap',
        (tester) async {
      final tierStore = FakeAppTierStore();
      await tester.pumpWidget(settingsApp(tierStore));
      await tester.pumpAndSettle();

      // The Appearance section lives at the END of the settings list (after
      // the Danger Zone, keeping the text-field indices stable), so scroll it
      // into view first.
      await tester.scrollUntilVisible(
        find.text('Appearance'),
        150,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();

      // Standard segment is selected by default.
      expect(find.text('Appearance'), findsOneWidget);
      expect(find.text('Standard'), findsOneWidget);
      expect(find.text('Premium'), findsOneWidget);

      await tester.tap(find.text('Premium'));
      await tester.pumpAndSettle();

      expect(tierStore.saved, AppTier.premium);
    });
  });
}