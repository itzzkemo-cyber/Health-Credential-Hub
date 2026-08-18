import React, { useState } from 'react';
import { View, FlatList, TextInput, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useListEmployees, getListEmployeesQueryKey } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { EmployeeCard } from '@/components/EmployeeCard';
import { ScreenHeader } from '@/components/ScreenHeader';
import { EmptyState } from '@/components/EmptyState';

export default function EmployeesScreen() {
  const colors = useColors();
  const { t, isRTL } = useLanguage();
  const { currentUser } = useAuth();

  const [search, setSearch] = useState('');

  const isAllowed = !!currentUser && currentUser.role !== 'employee';

  const { data: employees, isLoading, isError, refetch, isRefetching } = useListEmployees(undefined, {
    query: { queryKey: getListEmployeesQueryKey(), enabled: isAllowed },
  });

  if (!currentUser) return null;

  if (!isAllowed) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <EmptyState icon="lock-closed" title={t('employees.unauthorized')} />
      </View>
    );
  }

  // The server already scopes the list to the caller's team/department/facility.
  let list = employees ?? [];
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter(e =>
      e.name.toLowerCase().includes(q) ||
      (e.nameAr && e.nameAr.includes(search.trim())) ||
      (e.employeeNumber && e.employeeNumber.includes(search.trim()))
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title={t('employees.title')} />

      <View style={styles.top}>
        <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: isRTL ? 'row-reverse' : 'row' }]}>
          <Ionicons name="search" size={20} color={colors.mutedForeground} />
          <TextInput
            style={[styles.input, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}
            placeholder={t('employees.search')}
            placeholderTextColor={colors.mutedForeground}
            value={search}
            onChangeText={setSearch}
          />
        </View>
      </View>

      {isLoading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.centerBox}>
          <Text style={{ color: colors.mutedForeground, marginBottom: 12 }}>{t('common.error')}</Text>
          <Pressable onPress={() => refetch()} style={[styles.retryBtn, { backgroundColor: colors.primary }]}>
            <Text style={{ color: 'white', fontWeight: 'bold' }}>{t('common.retry')}</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={e => String(e.id)}
          contentContainerStyle={styles.list}
          onRefresh={refetch}
          refreshing={isRefetching}
          renderItem={({ item }) => <EmployeeCard employee={item} />}
          ListEmptyComponent={<EmptyState icon="people" title={t('employees.empty')} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    padding: 16,
  },
  searchBox: {
    paddingHorizontal: 12,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    height: '100%',
    fontSize: 16,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 120,
  },
  retryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 10,
  },
  list: {
    padding: 16,
    paddingBottom: 120,
  }
});
