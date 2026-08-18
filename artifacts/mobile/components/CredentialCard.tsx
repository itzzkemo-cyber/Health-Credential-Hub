import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { Credential } from '@/data/types';
import { credentialTypes } from '@/data/credentialTypes';
import { StatusBadge } from './StatusBadge';
import { router } from 'expo-router';

interface CredentialCardProps {
  credential: Credential;
  showHolder?: boolean;
}

export function CredentialCard({ credential, showHolder }: CredentialCardProps) {
  const colors = useColors();
  const { isRTL, t } = useLanguage();

  const typeDef = credentialTypes[credential.type] || credentialTypes['custom'];
  const name =
    credential.type === 'custom' && credential.customTypeName
      ? (isRTL ? credential.customTypeNameAr || credential.customTypeName : credential.customTypeName)
      : (isRTL ? typeDef.nameAr : typeDef.nameEn);
  const issuer = isRTL && credential.issuerNameAr ? credential.issuerNameAr : credential.issuerName;
  const holder = isRTL && credential.holderNameAr ? credential.holderNameAr : credential.holderName;

  const today = new Date();
  const expiry = new Date(credential.expiryDate);
  const diffDays = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  const daysText = diffDays > 0 ? `${diffDays} ${t('common.daysLeft')}` : `${Math.abs(diffDays)} ${t('common.daysAgo')}`;

  let catColor = colors.primary;
  if (typeDef.category === 'safety') catColor = colors.warning;
  if (typeDef.category === 'admin') catColor = colors.accent;
  if (typeDef.category === 'legal') catColor = colors.success;

  return (
    <Pressable
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: isRTL ? 'row-reverse' : 'row' }]}
      onPress={() => router.push(`/credential/${credential.id}`)}
    >
      <View style={[styles.iconBox, { backgroundColor: catColor + '15' }]}>
        <Ionicons name={typeDef.icon as any} size={24} color={catColor} />
      </View>

      <View style={[styles.content, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>{name}</Text>
        {showHolder && (
          <Text style={[styles.subtitle, { color: colors.primary }]} numberOfLines={1}>
            <Ionicons name="person" size={12} /> {holder}
          </Text>
        )}
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>{issuer}</Text>
      </View>

      <View style={[styles.right, { alignItems: isRTL ? 'flex-start' : 'flex-end' }]}>
        <StatusBadge status={credential.status} />
        <Text style={[styles.days, { color: colors.mutedForeground }]}>{daysText}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    alignItems: 'center',
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  iconBox: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    marginBottom: 2,
  },
  right: {
    justifyContent: 'center',
  },
  days: {
    fontSize: 11,
    marginTop: 6,
  }
});
