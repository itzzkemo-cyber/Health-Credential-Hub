import React from 'react';
import { KeyboardAvoidingView, ScrollView, Platform, StyleProp, ViewStyle, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  bottomOffset?: number;
}

export function KeyboardAwareScrollViewCompat({
  children,
  style,
  contentContainerStyle,
  bottomOffset = 20,
}: Props) {
  const insets = useSafeAreaInsets();

  if (Platform.OS === 'web') {
    return (
      <ScrollView
        style={style}
        contentContainerStyle={contentContainerStyle}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[{ flex: 1 }, style]}
    >
      <ScrollView
        contentContainerStyle={[
          contentContainerStyle,
          { paddingBottom: Math.max(insets.bottom, bottomOffset) },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
