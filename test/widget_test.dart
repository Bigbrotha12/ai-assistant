import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/main.dart';

void main() {
  testWidgets('connection screen renders', (WidgetTester tester) async {
    await tester.pumpWidget(const AiAssistantApp());
    expect(find.text('AI Assistant'), findsOneWidget);
  });
}
