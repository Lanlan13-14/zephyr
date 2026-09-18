import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/ui/liquid_toggle.dart';

void main() {
  testWidgets('liquid toggle taps to flip', (tester) async {
    var value = false;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Center(
          child: LiquidToggle(
            value: value,
            onChanged: (v) => value = v,
            activeColor: const Color(0xFF34C759),
          ),
        ),
      ),
    ));
    expect(find.byType(LiquidToggle), findsOneWidget);
    await tester.tap(find.byType(LiquidToggle));
    await tester.pump();
    expect(value, isTrue);
  });

  testWidgets('disabled toggle does not flip', (tester) async {
    var value = false;
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: Center(
          child: LiquidToggle(
            value: false,
            onChanged: null,
            activeColor: Color(0xFF34C759),
          ),
        ),
      ),
    ));
    await tester.tap(find.byType(LiquidToggle));
    await tester.pump();
    expect(value, isFalse);
  });
}
