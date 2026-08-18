import React from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator, Share } from 'react-native';
import { confirmDialog } from '@/lib/dialogs';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetCredential,
  useDeleteCredential,
  getGetCredentialQueryKey,
  getListCredentialsQueryKey,
  getGetDashboardStatsQueryKey,
  ApiError,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { StatusBadge } from '@/components/StatusBadge';
import { credentialTypes } from '@/data/credentialTypes';
import { getVerifyUrl } from '@/lib/api';
import QRCode from 'react-native-qrcode-svg';

export default function CredentialDetailScreen() {
  const { id } = useLocalSearchParams();
  const colors = useColors();
  const { t, isRTL } = useLanguage();
  const { currentUser } = useAuth();
  const queryClient = useQueryClient();

  const credId = Number(Array.isArray(id) ? id[0] : id);

  const { data: cred, isLoading, isError, error } = useGetCredential(credId, {
    query: { queryKey: getGetCredentialQueryKey(credId), enabled: Number.isFinite(credId) },
  });

  const deleteMutation = useDeleteCredential({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCredentialsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        // Employee screens embed credential lists and compliance counts.
        queryClient.invalidateQueries({
          predicate: q => String(q.queryKey[0] ?? '').startsWith('/api/employees'),
        });
        router.back();
      },
    },
  });

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (isError || !cred || !currentUser) {
    // A notification can point at a credential that was deleted since.
    const notFound = error instanceof ApiError && (error.status === 404 || error.status === 403);
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, padding: 24, gap: 16 }}>
        <Ionicons name={notFound ? 'document-outline' : 'cloud-offline-outline'} size={48} color={colors.mutedForeground} />
        <Text style={{ color: colors.foreground, fontSize: 16, textAlign: 'center' }}>
          {notFound ? t('credentials.notFound') : t('common.error')}
        </Text>
        <Pressable onPress={() => router.back()} style={{ backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 10 }}>
          <Text style={{ color: 'white', fontWeight: 'bold' }}>{t('common.back')}</Text>
        </Pressable>
      </View>
    );
  }

  const typeDef = credentialTypes[cred.type] || credentialTypes['custom'];
  const name =
    cred.type === 'custom' && cred.customTypeName
      ? (isRTL ? cred.customTypeNameAr || cred.customTypeName : cred.customTypeName)
      : (isRTL ? typeDef.nameAr : typeDef.nameEn);
  const issuer = isRTL && cred.issuerNameAr ? cred.issuerNameAr : cred.issuerName;
  const holder = isRTL && cred.holderNameAr ? cred.holderNameAr : cred.holderName;
  const verifyUrl = getVerifyUrl(cred.qrToken);

  const doDelete = () => deleteMutation.mutate({ id: cred.id });

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: t('common.confirmDelete'),
      confirmText: t('common.yes'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (ok) doDelete();
  };

  const handleShare = async () => {
    try {
      await Share.share({ message: verifyUrl });
    } catch {
      // Sharing cancelled or unsupported — nothing to do.
    }
  };

  const Row = ({ label, value }: { label: string; value: string }) => (
    <View style={[styles.row, { borderBottomColor: colors.border, flexDirection: isRTL ? 'row-reverse' : 'row' }]}>
      <Text style={[styles.label, { color: colors.mutedForeground, textAlign: isRTL ? 'right' : 'left' }]}>{label}</Text>
      <Text style={[styles.value, { color: colors.foreground, textAlign: isRTL ? 'left' : 'right' }]}>{value}</Text>
    </View>
  );

  let bgStatusColor = colors.muted;
  if (cred.status === 'active') bgStatusColor = colors.success;
  if (cred.status === 'expiring_soon') bgStatusColor = colors.warning;
  if (cred.status === 'expired') bgStatusColor = colors.destructive;

  const statusText =
    cred.status === 'active' ? t('dashboard.active')
    : cred.status === 'expiring_soon' ? t('dashboard.expiring')
    : cred.status === 'expired' ? t('dashboard.expired')
    : t('dashboard.missing');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>

      <View style={[styles.header, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.iconWrap, { backgroundColor: colors.primary + '15' }]}>
          <Ionicons name={typeDef.icon as any} size={32} color={colors.primary} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>{name}</Text>
        <StatusBadge status={cred.status} />
      </View>

      <View style={[styles.statusBlock, { backgroundColor: bgStatusColor + '15', borderColor: bgStatusColor + '30' }]}>
        <Text style={[styles.statusBlockText, { color: bgStatusColor }]}>{statusText}</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Row label={t('credentials.holder')} value={holder} />
        <Row label={t('credentials.issuer')} value={issuer} />
        <Row label={t('credentials.certNumber')} value={cred.certificateNumber} />
        <Row label={t('credentials.issueDate')} value={cred.issueDate} />
        <Row label={t('credentials.expiryDate')} value={cred.expiryDate} />
      </View>

      <View style={[styles.qrCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.qrTitle, { color: colors.foreground }]}>{t('credentials.scanToVerify')}</Text>
        <View style={styles.qrBox}>
          <QRCode
            value={verifyUrl}
            size={160}
            color="#000000"
            backgroundColor="#FFFFFF"
          />
        </View>
        <Pressable style={[styles.shareBtn, { backgroundColor: colors.primary + '15' }]} onPress={handleShare}>
          <Ionicons name="share-outline" size={20} color={colors.primary} />
          <Text style={{ color: colors.primary, fontWeight: 'bold' }}>{t('credentials.shareQr')}</Text>
        </Pressable>
      </View>

      {(currentUser.id === cred.employeeId || currentUser.role !== 'employee') && (
        <Pressable
          style={[styles.deleteBtn, { backgroundColor: colors.destructive + '15', flexDirection: isRTL ? 'row-reverse' : 'row', opacity: deleteMutation.isPending ? 0.6 : 1 }]}
          onPress={handleDelete}
          disabled={deleteMutation.isPending}
        >
          {deleteMutation.isPending ? (
            <ActivityIndicator color={colors.destructive} />
          ) : (
            <Ionicons name="trash" size={20} color={colors.destructive} />
          )}
          <Text style={{ color: colors.destructive, fontWeight: 'bold' }}>{t('common.delete')}</Text>
        </Pressable>
      )}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  statusBlock: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    marginBottom: 24,
  },
  statusBlockText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 24,
  },
  row: {
    padding: 16,
    borderBottomWidth: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: {
    fontSize: 14,
    flex: 1,
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
    flex: 2,
  },
  qrCard: {
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    marginBottom: 24,
  },
  qrTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  qrBox: {
    padding: 16,
    backgroundColor: 'white',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
    marginBottom: 24,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 20,
  },
  deleteBtn: {
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  }
});
