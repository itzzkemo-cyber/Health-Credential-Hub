import React from 'react';
import { View, FlatList, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  getListNotificationsQueryKey,
  getGetUnreadCountQueryKey,
} from '@workspace/api-client-react';
import type { Notification } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { ScreenHeader } from '@/components/ScreenHeader';
import { EmptyState } from '@/components/EmptyState';
import { router } from 'expo-router';

export default function NotificationsScreen() {
  const colors = useColors();
  const { t, isRTL } = useLanguage();
  const { currentUser } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch, isRefetching } = useListNotifications(undefined, {
    query: { queryKey: getListNotificationsQueryKey(), enabled: !!currentUser },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetUnreadCountQueryKey() });
  };

  const markRead = useMarkNotificationRead({ mutation: { onSuccess: invalidate } });
  const markAll = useMarkAllNotificationsRead({ mutation: { onSuccess: invalidate } });

  if (!currentUser) return null;

  const myNotifs = [...(data ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const getIcon = (type: string) => {
    switch (type) {
      case 'expiry_warning': return { name: 'warning', color: colors.warning };
      case 'expired': return { name: 'close-circle', color: colors.destructive };
      case 'new_credential': return { name: 'checkmark-circle', color: colors.success };
      default: return { name: 'information-circle', color: colors.primary };
    }
  };

  const handlePress = (n: Notification) => {
    if (!n.isRead) markRead.mutate({ id: n.id });
    if (n.credentialId) {
      router.push(`/credential/${n.credentialId}`);
    } else if (n.employeeId) {
      router.push(`/employee/${n.employeeId}`);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title={t('notifications.title')} />

      {myNotifs.length > 0 && (
        <View style={{ paddingHorizontal: 20, paddingTop: 16, alignItems: isRTL ? 'flex-start' : 'flex-end' }}>
          <Pressable onPress={() => markAll.mutate()} disabled={markAll.isPending}>
            <Text style={{ color: colors.primary, fontWeight: '600', opacity: markAll.isPending ? 0.5 : 1 }}>
              {t('notifications.markAllRead')}
            </Text>
          </Pressable>
        </View>
      )}

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
          data={myNotifs}
          keyExtractor={n => String(n.id)}
          contentContainerStyle={styles.list}
          onRefresh={refetch}
          refreshing={isRefetching}
          renderItem={({ item }) => {
            const icon = getIcon(item.type);
            return (
              <Pressable
                style={[styles.card, { backgroundColor: item.isRead ? colors.background : colors.card, borderColor: colors.border, flexDirection: isRTL ? 'row-reverse' : 'row' }]}
                onPress={() => handlePress(item)}
              >
                <View style={[styles.iconBox, { backgroundColor: icon.color + '15' }]}>
                  <Ionicons name={icon.name as any} size={24} color={icon.color} />
                </View>
                <View style={[styles.content, { alignItems: isRTL ? 'flex-end' : 'flex-start' }]}>
                  <Text style={[styles.title, { color: colors.foreground, fontWeight: item.isRead ? 'normal' : 'bold' }]}>
                    {isRTL ? item.titleAr : item.titleEn}
                  </Text>
                  <Text style={[styles.message, { color: colors.mutedForeground, textAlign: isRTL ? 'right' : 'left' }]}>
                    {isRTL ? item.messageAr : item.messageEn}
                  </Text>
                </View>
                {!item.isRead && (
                  <View style={[styles.dot, { backgroundColor: colors.primary }]} />
                )}
              </Pressable>
            );
          }}
          ListEmptyComponent={<EmptyState icon="notifications-off" title={t('notifications.empty')} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
    gap: 12,
  },
  card: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    gap: 12,
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
  },
  title: {
    fontSize: 16,
    marginBottom: 4,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  }
});
