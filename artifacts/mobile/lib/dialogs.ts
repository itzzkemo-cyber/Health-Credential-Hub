import { Alert, Platform } from 'react-native';

/** Web-safe alert — Alert.alert is a no-op on react-native-web. */
export function showMessage(title: string, message?: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert([title, message].filter(Boolean).join('\n'));
    return;
  }
  Alert.alert(title, message);
}

/** Web-safe confirm dialog; resolves to the user's choice. */
export function confirmDialog(opts: {
  title: string;
  message?: string;
  confirmText: string;
  cancelText: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    if (Platform.OS === 'web') {
      const text = [opts.title, opts.message].filter(Boolean).join('\n');
      resolve(typeof window !== 'undefined' && window.confirm(text));
      return;
    }
    let settled = false;
    const done = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    Alert.alert(
      opts.title,
      opts.message,
      [
        { text: opts.cancelText, style: 'cancel', onPress: () => done(false) },
        {
          text: opts.confirmText,
          style: opts.destructive ? 'destructive' : 'default',
          onPress: () => done(true),
        },
      ],
      { cancelable: true, onDismiss: () => done(false) },
    );
  });
}
