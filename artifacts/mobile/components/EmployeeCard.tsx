import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { EmployeeWithStats } from '@/data/types';
import { ComplianceBar } from './ComplianceBar';
import { router } from 'expo-router';

export function EmployeeCard({ employee }: { employee: EmployeeWithStats }) {
  const colors = useColors();
  const { isRTL } = useLanguage();

  const complianceRate = Math.round(employee.complianceRate ?? 100);
  const expiredCount = employee.expiredCount ?? 0;
  const expiringCount = employee.expiringCount ?? 0;

  const name = isRTL ? employee.nameAr : employee.name;
  const initials = (name || '?').substring(0, 2).toUpperCase();

  return (
    <Pressable
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: isRTL ? 'row-reverse' : 'row' }]}
      onPress={() => router.push(`/employee/${employee.id}`)}
    >
      <View style={[styles.avatar, { backgroundColor: colors.primary + '20' }]}>
        <Text style={[styles.avatarText, { color: colors.primary }]}>{initials}</Text>
      </View>

      <View style={[styles.content, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
        <Text style={[styles.name, { color: colors.foreground }]}>{name}</Text>
        <Text style={[styles.jobTitle, { color: colors.mutedForeground }]}>{isRTL ? employee.jobTitleAr : employee.jobTitle}</Text>

        <View style={styles.barWrap}>
          <View style={{ flex: 1 }}>
            <ComplianceBar percentage={complianceRate} />
          </View>
          <Text style={[styles.pct, { color: colors.mutedForeground }]}>{complianceRate}%</Text>
        </View>
      </View>

      <View style={styles.badges}>
        {expiredCount > 0 && (
          <View style={[styles.miniBadge, { backgroundColor: colors.destructive + '20' }]}>
            <Text style={[styles.miniBadgeText, { color: colors.destructive }]}>{expiredCount}</Text>
          </View>
        )}
        {expiringCount > 0 && (
          <View style={[styles.miniBadge, { backgroundColor: colors.warning + '20' }]}>
            <Text style={[styles.miniBadgeText, { color: colors.warning }]}>{expiringCount}</Text>
          </View>
        )}
      </View>

      <Ionicons name={isRTL ? 'chevron-back' : 'chevron-forward'} size={20} color={colors.mutedForeground} />
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
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  jobTitle: {
    fontSize: 13,
    marginBottom: 8,
  },
  barWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: '100%',
  },
  pct: {
    fontSize: 12,
    fontWeight: '600',
  },
  badges: {
    flexDirection: 'column',
    gap: 4,
  },
  miniBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniBadgeText: {
    fontSize: 12,
    fontWeight: 'bold',
  }
});
