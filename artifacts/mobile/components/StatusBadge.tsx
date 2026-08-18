import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { CredentialStatus } from '@/data/types';

export function StatusBadge({ status }: { status: CredentialStatus }) {
  const colors = useColors();
  const { t } = useLanguage();

  let bgColor = colors.muted;
  let textColor = colors.mutedForeground;
  let icon = 'help-circle';
  let label = '';

  switch (status) {
    case 'active':
      bgColor = colors.success + '20';
      textColor = colors.success;
      icon = 'checkmark-circle';
      label = t('dashboard.active');
      break;
    case 'expiring_soon':
      bgColor = colors.warning + '20';
      textColor = colors.warning;
      icon = 'alert-circle';
      label = t('dashboard.expiring');
      break;
    case 'expired':
      bgColor = colors.destructive + '20';
      textColor = colors.destructive;
      icon = 'close-circle';
      label = t('dashboard.expired');
      break;
    case 'missing':
      bgColor = colors.muted;
      textColor = colors.mutedForeground;
      icon = 'remove-circle';
      label = t('dashboard.missing');
      break;
  }

  return (
    <View style={[styles.badge, { backgroundColor: bgColor }]}>
      <Ionicons name={icon as any} size={14} color={textColor} />
      <Text style={[styles.text, { color: textColor }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 4,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
  }
});
