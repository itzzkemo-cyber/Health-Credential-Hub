import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function ScreenHeader({ title }: { title: string }) {
  const colors = useColors();
  const { isRTL } = useLanguage();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, {
      backgroundColor: colors.card,
      borderBottomColor: colors.border,
      paddingTop: Platform.OS === 'web' ? 67 : insets.top,
    }]}>
      <Text style={[styles.title, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  }
});
