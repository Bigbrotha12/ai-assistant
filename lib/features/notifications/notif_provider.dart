import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'notif_client.dart';

final notifClientProvider = Provider<NotifClient>((ref) => const NoOpNotifClient());
