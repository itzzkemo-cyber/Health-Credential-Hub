import React, { useEffect, useState } from 'react';
import { View, FlatList, TextInput, Pressable, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useListCredentials, getListCredentialsQueryKey } from '@workspace/api-client-react';
import type { ListCredentialsParams } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { CredentialCard } from '@/components/CredentialCard';
import { ScreenHeader } from '@/components/ScreenHeader';
import { router } from 'expo-router';
import { EmptyState } from '@/components/EmptyState';

type StatusFilter = 'all' | 'active' | 'expiring_soon' | 'expired';

export default function CredentialsScreen() {
  const colors = useColors();
  const { t, isRTL } = useLanguage();
  const { currentUser } = useAuth();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);

  const params: ListCredentialsParams = { pageSize: 100 };
  if (debouncedSearch) params.search = debouncedSearch;
  if (filter !== 'all') params.status = filter;

  const { data, isLoading, isError, refetch, isRefetching } = useListCredentials(params, {
    query: { queryKey: getListCredentialsQueryKey(params), enabled: !!currentUser },
  });

  if (!currentUser) return null;

  const creds = data?.data ?? [];

  const filters: { id: StatusFilter; label: string; color: string }[] = [
    { id: 'all', label: t('credentials.all'), color: colors.primary },
    { id: 'active', label: t('dashboard.active'), color: colors.success },
    { id: 'expiring_soon', label: t('dashboard.expiring'), color: colors.warning },
    { id: 'expired', label: t('dashboard.expired'), color: colors.destructive },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title={t('credentials.title')} />

      <View style={styles.top}>
        <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: isRTL ? 'row-reverse' : 'row' }]}>
          <Ionicons name="search" size={20} color={colors.mutedForeground} />
          <TextInput
            style={[styles.input, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}
            placeholder={t('credentials.search')}
            placeholderTextColor={colors.mutedForeground}
            value={search}
            onChangeText={setSearch}
          />
        </View>

        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={filters}
          keyExtractor={f => f.id}
          style={styles.filterList}
          contentContainerStyle={[styles.filterContainer, { flexDirection: isRTL ? 'row-reverse' : 'row' }]}
          renderItem={({ item }) => {
            const active = filter === item.id;
            return (
              <Pressable
                onPress={() => setFilter(item.id)}
                style={[
                  styles.filterChip,
                  {
                    backgroundColor: active ? item.color : colors.card,
                    borderColor: active ? item.color : colors.border,
                  }
                ]}
              >
                <Text style={{ color: active ? 'white' : colors.mutedForeground, fontWeight: active ? 'bold' : 'normal' }}>
                  {item.label}
                </Text>
              </Pressable>
            );
          }}
        />
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
          data={creds}
          keyExtractor={c => String(c.id)}
          contentContainerStyle={styles.list}
          onRefresh={refetch}
          refreshing={isRefetching}
          renderItem={({ item }) => <CredentialCard credential={item} showHolder={currentUser.role !== 'employee'} />}
          ListEmptyComponent={<EmptyState icon="document" title={t('credentials.empty')} subtitle={t('credentials.emptyHint')} />}
        />
      )}

      <Pressable
        style={[styles.fab, { backgroundColor: colors.primary }]}
        onPress={() => router.push('/credential/add')}
      >
        <Ionicons name="add" size={32} color="white" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    padding: 16,
    gap: 16,
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
  filterList: {
    flexGrow: 0,
  },
  filterContainer: {
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
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
  },
  fab: {
    position: 'absolute',
    bottom: 100,
    right: 24,
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  }
});
