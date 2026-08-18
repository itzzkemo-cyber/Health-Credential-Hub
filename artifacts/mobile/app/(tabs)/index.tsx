import React from 'react';
import { ScrollView, View, Text, StyleSheet, ActivityIndicator, Pressable, RefreshControl } from 'react-native';
import {
  useGetDashboardStats,
  useListEmployees,
  getGetDashboardStatsQueryKey,
  getListEmployeesQueryKey,
} from '@workspace/api-client-react';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { useColors } from '@/hooks/useColors';
import { StatCard } from '@/components/StatCard';
import { CredentialCard } from '@/components/CredentialCard';
import { EmployeeCard } from '@/components/EmployeeCard';
import { ScreenHeader } from '@/components/ScreenHeader';

export default function DashboardScreen() {
  const { currentUser } = useAuth();
  const { t, isRTL } = useLanguage();
  const colors = useColors();

  const isManager = !!currentUser && currentUser.role !== 'employee';

  const {
    data: stats,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey(), enabled: !!currentUser },
  });

  const { data: atRiskEmployees, refetch: refetchAtRisk } = useListEmployees(
    { atRisk: true },
    { query: { queryKey: getListEmployeesQueryKey({ atRisk: true }), enabled: isManager } },
  );

  if (!currentUser) return null;

  const name = isRTL ? currentUser.nameAr : currentUser.name;
  const roleName =
    (isRTL ? currentUser.jobTitleAr : currentUser.jobTitle) ||
    t(`auth.roles.${currentUser.role}`);

  const onRefresh = () => {
    refetch();
    if (isManager) refetchAtRisk();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title={t('nav.dashboard')} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >

        <View style={[styles.greeting, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
          <Text style={[styles.greetingTitle, { color: colors.foreground }]}>{t('dashboard.welcome')}, {name}</Text>
          <Text style={[styles.greetingSub, { color: colors.mutedForeground }]}>{roleName}</Text>
        </View>

        {isLoading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : isError || !stats ? (
          <View style={styles.centerBox}>
            <Text style={{ color: colors.mutedForeground, marginBottom: 12 }}>{t('common.error')}</Text>
            <Pressable onPress={onRefresh} style={[styles.retryBtn, { backgroundColor: colors.primary }]}>
              <Text style={{ color: 'white', fontWeight: 'bold' }}>{t('common.retry')}</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.grid}>
              {isManager ? (
                <StatCard title={t('dashboard.totalEmployees')} value={stats.totalEmployees} icon="people" color={colors.primary} />
              ) : (
                <StatCard title={t('dashboard.totalCredentials')} value={stats.totalCredentials} icon="document-text" color={colors.primary} />
              )}
              <StatCard title={t('dashboard.active')} value={stats.activeCredentials} icon="checkmark-circle" color={colors.success} />
              <StatCard title={t('dashboard.expiring')} value={stats.expiringCredentials} icon="alert-circle" color={colors.warning} />
              <StatCard title={t('dashboard.expired')} value={stats.expiredCredentials} icon="close-circle" color={colors.destructive} />
            </View>

            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>
                {t('dashboard.complianceRate')}
              </Text>
              <View style={styles.compWrap}>
                <View style={[styles.compCircle, { borderColor: stats.complianceRate >= 80 ? colors.success : stats.complianceRate >= 60 ? colors.warning : colors.destructive }]}>
                  <Text style={[styles.compText, { color: colors.foreground }]}>{Math.round(stats.complianceRate)}%</Text>
                </View>
              </View>
            </View>

            <Text style={[styles.listTitle, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>
              {t('dashboard.upcomingExpirations')}
            </Text>
            {(stats.upcomingExpirations?.length ?? 0) > 0 ? (
              stats.upcomingExpirations!.map(cred => (
                <CredentialCard key={cred.id} credential={cred} showHolder={isManager} />
              ))
            ) : (
              <Text style={[styles.emptyText, { color: colors.mutedForeground, textAlign: isRTL ? 'right' : 'left' }]}>
                {t('dashboard.noUpcoming')}
              </Text>
            )}

            {isManager && (atRiskEmployees?.length ?? 0) > 0 && (
              <>
                <Text style={[styles.listTitle, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left', marginTop: 24 }]}>
                  {t('dashboard.atRisk')}
                </Text>
                {atRiskEmployees!.slice(0, 3).map(emp => (
                  <EmployeeCard key={emp.id} employee={emp} />
                ))}
              </>
            )}
          </>
        )}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: 20,
    paddingBottom: 120,
  },
  greeting: {
    marginBottom: 24,
  },
  greetingTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  greetingSub: {
    fontSize: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 24,
  },
  centerBox: {
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 10,
  },
  section: {
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  compWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  compCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compText: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  listTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 14,
    fontStyle: 'italic',
  }
});
