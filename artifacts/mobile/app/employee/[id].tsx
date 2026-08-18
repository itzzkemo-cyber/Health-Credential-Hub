import React from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGetEmployee, getGetEmployeeQueryKey, ApiError } from '@workspace/api-client-react';
import { router } from 'expo-router';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { ComplianceBar } from '@/components/ComplianceBar';
import { CredentialCard } from '@/components/CredentialCard';

export default function EmployeeDetailScreen() {
  const { id } = useLocalSearchParams();
  const colors = useColors();
  const { t, isRTL } = useLanguage();

  const employeeId = Number(Array.isArray(id) ? id[0] : id);

  const { data: employee, isLoading, isError, error } = useGetEmployee(employeeId, {
    query: { queryKey: getGetEmployeeQueryKey(employeeId), enabled: Number.isFinite(employeeId) },
  });

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (isError || !employee) {
    const notFound = error instanceof ApiError && (error.status === 404 || error.status === 403);
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, padding: 24, gap: 16 }}>
        <Ionicons name={notFound ? 'person-outline' : 'cloud-offline-outline'} size={48} color={colors.mutedForeground} />
        <Text style={{ color: colors.foreground, fontSize: 16, textAlign: 'center' }}>
          {notFound ? t('employees.notFound') : t('common.error')}
        </Text>
        <Pressable onPress={() => router.back()} style={{ backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 10 }}>
          <Text style={{ color: 'white', fontWeight: 'bold' }}>{t('common.back')}</Text>
        </Pressable>
      </View>
    );
  }

  const credentials = employee.credentials ?? [];
  const complianceRate = Math.round(employee.complianceRate ?? 100);
  const activeCount = credentials.filter(c => c.status === 'active').length;
  const expiringCount = employee.expiringCount ?? 0;
  const expiredCount = employee.expiredCount ?? 0;

  const name = isRTL ? employee.nameAr : employee.name;
  const initials = (name || '?').substring(0, 2).toUpperCase();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>

      <View style={[styles.header, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={[styles.name, { color: colors.foreground }]}>{name}</Text>
        <Text style={[styles.job, { color: colors.mutedForeground }]}>{isRTL ? employee.jobTitleAr : employee.jobTitle}</Text>
        <Text style={[styles.idText, { color: colors.mutedForeground }]}>ID: {employee.employeeNumber}</Text>
      </View>

      <View style={[styles.compCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={{ flexDirection: isRTL ? 'row-reverse' : 'row', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text style={{ color: colors.foreground, fontWeight: 'bold' }}>{t('dashboard.complianceRate')}</Text>
          <Text style={{ color: colors.foreground, fontWeight: 'bold' }}>{complianceRate}%</Text>
        </View>
        <ComplianceBar percentage={complianceRate} />
        <View style={{ flexDirection: isRTL ? 'row-reverse' : 'row', gap: 16, marginTop: 16 }}>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 20, fontWeight: 'bold', color: colors.success }}>{activeCount}</Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground }}>{t('dashboard.active')}</Text>
          </View>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 20, fontWeight: 'bold', color: colors.warning }}>{expiringCount}</Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground }}>{t('dashboard.expiring')}</Text>
          </View>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 20, fontWeight: 'bold', color: colors.destructive }}>{expiredCount}</Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground }}>{t('dashboard.expired')}</Text>
          </View>
        </View>
      </View>

      <Text style={[styles.sectionTitle, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>
        {t('employees.credentials')}
      </Text>

      <View style={{ gap: 12 }}>
        {credentials.map(c => <CredentialCard key={c.id} credential={c} />)}
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    marginBottom: 20,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  avatarText: {
    color: 'white',
    fontSize: 32,
    fontWeight: 'bold',
  },
  name: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  job: {
    fontSize: 16,
    marginBottom: 4,
  },
  idText: {
    fontSize: 14,
  },
  compCard: {
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
  }
});
