import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, ActivityIndicator } from 'react-native';
import { showMessage, confirmDialog } from '@/lib/dialogs';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCreateCredential,
  useRequestUploadUrl,
  useExtractCredentialOcr,
  checkDuplicate,
  getListCredentialsQueryKey,
  getGetDashboardStatsQueryKey,
} from '@workspace/api-client-react';
import type { OcrResult, CredentialInput } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { CredentialTypeKey } from '@/data/types';
import { credentialTypes } from '@/data/credentialTypes';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { OcrScanModal } from '@/components/OcrScanModal';
import { fileUriToBlob, uploadFileToStorage } from '@/lib/api';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_MIME = /^(image\/(png|jpe?g|webp|gif|avif|heic|heif)|application\/pdf)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALL_TYPES = Object.keys(credentialTypes) as CredentialTypeKey[];

interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
}

export default function AddCredentialScreen() {
  const colors = useColors();
  const { t, isRTL } = useLanguage();
  const { currentUser } = useAuth();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'manual' | 'smart'>('manual');

  // Form state
  const [type, setType] = useState<CredentialTypeKey>('BLS');
  const [customTypeName, setCustomTypeName] = useState('');
  const [holderName, setHolderName] = useState(currentUser?.name || '');
  const [holderNameAr, setHolderNameAr] = useState(currentUser?.nameAr || '');
  const [issuerName, setIssuerName] = useState('');
  const [issuerNameAr, setIssuerNameAr] = useState('');
  const [certNumber, setCertNumber] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileIsPdf, setFileIsPdf] = useState(false);
  const [saving, setSaving] = useState(false);

  // OCR state
  const [ocrVisible, setOcrVisible] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);

  const requestUpload = useRequestUploadUrl();
  const extractOcr = useExtractCredentialOcr();
  const createCredential = useCreateCredential();

  /** Upload the picked file and run real AI extraction on the server. */
  const processFile = async (file: PickedFile) => {
    // Reset any previous attachment first so a failed new attempt can't
    // silently leave the old file attached to the credential being created.
    setFileUrl(null);
    setFileIsPdf(false);
    setOcrVisible(true);
    setOcrLoading(true);
    setOcrError(null);
    setOcrResult(null);
    try {
      const blob = await fileUriToBlob(file.uri);
      const contentType = file.mimeType || blob.type || 'image/jpeg';
      if (!SUPPORTED_MIME.test(contentType)) {
        throw new Error(t('ocr.unsupportedFile'));
      }
      if (blob.size > MAX_FILE_BYTES) {
        throw new Error(t('ocr.tooLarge'));
      }
      const presign = await requestUpload.mutateAsync({
        data: { name: file.name, size: blob.size, contentType },
      });
      await uploadFileToStorage(
        presign.uploadURL,
        blob,
        contentType,
        presign.requiredHeaders,
      );
      setFileUrl(presign.objectPath);
      setFileIsPdf(contentType.toLowerCase() === 'application/pdf');
      const res = await extractOcr.mutateAsync({
        data: { fileUrl: presign.objectPath, fileName: file.name },
      });
      setOcrResult(res);
    } catch (err: any) {
      setOcrError(err?.message && !String(err.message).startsWith('HTTP ') ? String(err.message) : t('ocr.failed'));
    } finally {
      setOcrLoading(false);
    }
  };

  // Camera / photo library: images only (expo-image-picker cannot handle PDFs).
  const handlePickImage = async (fromCamera: boolean) => {
    try {
      const result = fromCamera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        await processFile({
          uri: asset.uri,
          name: asset.fileName || `photo-${Date.now()}.jpg`,
          mimeType: asset.mimeType || 'image/jpeg',
        });
      }
    } catch {
      showMessage(t('common.error'), t('ocr.unsupportedFile'));
    }
  };

  // Main upload zone: certificate images AND PDF files via the document picker.
  const handlePickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        await processFile({
          uri: asset.uri,
          name: asset.name || `document-${Date.now()}`,
          mimeType: asset.mimeType || '',
        });
      }
    } catch {
      showMessage(t('common.error'), t('ocr.unsupportedFile'));
    }
  };

  /** Fill the form from the AI extraction result, then let the user review. */
  const applyOcrResult = (res: OcrResult) => {
    const detected = res.detectedType as CredentialTypeKey;
    if (credentialTypes[detected]) {
      setType(detected);
    } else {
      setType('custom');
      setCustomTypeName(res.detectedType);
    }
    if (res.holderName) setHolderName(res.holderName);
    if (res.holderNameAr) setHolderNameAr(res.holderNameAr);
    if (res.issuerName) setIssuerName(res.issuerName);
    if (res.issuerNameAr) setIssuerNameAr(res.issuerNameAr);
    if (res.certificateNumber) setCertNumber(res.certificateNumber);
    if (res.issueDate) setIssueDate(res.issueDate);
    if (res.expiryDate) setExpiryDate(res.expiryDate);
    setOcrVisible(false);
    setMode('manual'); // Switch to the form so the user reviews before saving.
  };

  const handleSave = async () => {
    if (!currentUser || saving) return;
    if (!certNumber.trim() || !expiryDate.trim() || !issuerName.trim()) {
      showMessage(t('common.error'), t('credentials.requiredFields'));
      return;
    }
    if (!DATE_RE.test(expiryDate.trim()) || (issueDate.trim() && !DATE_RE.test(issueDate.trim()))) {
      showMessage(t('common.error'), t('credentials.dateFormat'));
      return;
    }

    setSaving(true);
    try {
      try {
        const dup = await checkDuplicate({
          employeeId: currentUser.id,
          type,
          certificateNumber: certNumber.trim(),
        });
        if (dup.isDuplicate) {
          const proceed = await confirmDialog({
            title: t('credentials.duplicate'),
            confirmText: t('common.yes'),
            cancelText: t('common.cancel'),
          });
          if (!proceed) return;
        }
      } catch {
        // Duplicate check is advisory — saving still validated server-side.
      }

      const input: CredentialInput = {
        employeeId: currentUser.id,
        type,
        holderName: holderName.trim() || currentUser.name,
        holderNameAr: holderNameAr.trim() || currentUser.nameAr || holderName.trim() || currentUser.name,
        issuerName: issuerName.trim(),
        issuerNameAr: issuerNameAr.trim() || issuerName.trim(),
        certificateNumber: certNumber.trim(),
        issueDate: issueDate.trim() || new Date().toISOString().split('T')[0],
        expiryDate: expiryDate.trim(),
        ...(type === 'custom' && customTypeName.trim()
          ? { customTypeName: customTypeName.trim(), customTypeNameAr: customTypeName.trim() }
          : {}),
        ...(fileUrl ? { fileUrl, fileType: fileIsPdf ? 'pdf' as const : 'image' as const } : {}),
        ...(ocrResult?.confidence?.overall != null ? { confidence: ocrResult.confidence.overall } : {}),
      };

      await createCredential.mutateAsync({ data: input });
      queryClient.invalidateQueries({ queryKey: getListCredentialsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
      // Employee screens embed credential lists and compliance counts.
      queryClient.invalidateQueries({
        predicate: q => String(q.queryKey[0] ?? '').startsWith('/api/employees'),
      });
      router.back();
    } catch (err) {
      showMessage(t('common.error'), t('credentials.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const Segment = () => (
    <View style={[styles.segmentWrap, { backgroundColor: colors.muted, flexDirection: isRTL ? 'row-reverse' : 'row' }]}>
      <Pressable style={[styles.segmentBtn, mode === 'manual' && { backgroundColor: colors.card, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 2 }]} onPress={() => setMode('manual')}>
        <Text style={{ color: mode === 'manual' ? colors.foreground : colors.mutedForeground, fontWeight: mode === 'manual' ? 'bold' : 'normal' }}>{t('credentials.manual')}</Text>
      </Pressable>
      <Pressable style={[styles.segmentBtn, mode === 'smart' && { backgroundColor: colors.card, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 2 }]} onPress={() => setMode('smart')}>
        <Text style={{ color: mode === 'smart' ? colors.foreground : colors.mutedForeground, fontWeight: mode === 'smart' ? 'bold' : 'normal' }}>{t('credentials.smart')}</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Segment />

        {mode === 'smart' ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 40, gap: 24 }}>
            <Pressable
              style={[styles.uploadBig, { borderColor: colors.primary, borderStyle: 'dashed', backgroundColor: colors.primary + '0A' }]}
              onPress={handlePickFile}
            >
              <Ionicons name="scan" size={64} color={colors.primary} />
              <Text style={{ color: colors.primary, fontSize: 16, marginTop: 16, fontWeight: '600', textAlign: 'center' }}>
                {t('ocr.uploadPrompt')}
              </Text>
            </Pressable>
            <View style={{ flexDirection: isRTL ? 'row-reverse' : 'row', gap: 16 }}>
              <Pressable style={[styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => handlePickImage(true)}>
                <Ionicons name="camera-outline" size={24} color={colors.foreground} />
                <Text style={{ color: colors.foreground }}>{t('credentials.camera')}</Text>
              </Pressable>
              <Pressable style={[styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => handlePickImage(false)}>
                <Ionicons name="images-outline" size={24} color={colors.foreground} />
                <Text style={{ color: colors.foreground }}>{t('credentials.photoLibrary')}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.form}>
            <Text style={[styles.label, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>{t('credentials.type')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, flexDirection: isRTL ? 'row-reverse' : 'row' }} style={{ flexGrow: 0 }}>
              {ALL_TYPES.map(key => {
                const def = credentialTypes[key];
                const active = type === key;
                return (
                  <Pressable
                    key={key}
                    onPress={() => setType(key)}
                    style={[styles.typeChip, { backgroundColor: active ? colors.primary : colors.card, borderColor: active ? colors.primary : colors.border }]}
                  >
                    <Ionicons name={def.icon as any} size={14} color={active ? 'white' : colors.mutedForeground} />
                    <Text style={{ color: active ? 'white' : colors.foreground, fontSize: 13 }}>{isRTL ? def.nameAr : def.nameEn}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {type === 'custom' && (
              <>
                <Text style={[styles.label, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>{t('credentials.customName')}</Text>
                <TextInput style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]} value={customTypeName} onChangeText={setCustomTypeName} />
              </>
            )}

            <Text style={[styles.label, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>{t('credentials.holder')}</Text>
            <TextInput style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]} value={holderName} onChangeText={setHolderName} />

            <Text style={[styles.label, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>{t('credentials.issuer')}</Text>
            <TextInput style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]} value={issuerName} onChangeText={setIssuerName} />

            <Text style={[styles.label, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>{t('credentials.certNumber')}</Text>
            <TextInput style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]} value={certNumber} onChangeText={setCertNumber} />

            <Text style={[styles.label, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>{t('credentials.issueDate')} (YYYY-MM-DD)</Text>
            <TextInput style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]} value={issueDate} onChangeText={setIssueDate} placeholder="2025-08-04" placeholderTextColor={colors.mutedForeground} />

            <Text style={[styles.label, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>{t('credentials.expiryDate')} (YYYY-MM-DD)</Text>
            <TextInput style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]} value={expiryDate} onChangeText={setExpiryDate} placeholder="2027-08-04" placeholderTextColor={colors.mutedForeground} />

            {fileUrl && (
              <View style={{ flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="attach" size={18} color={colors.success} />
                <Text style={{ color: colors.success, fontSize: 13 }}>{t('credentials.fileAttached')}</Text>
              </View>
            )}

            <Pressable style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: saving ? 0.7 : 1 }]} onPress={handleSave} disabled={saving}>
              {saving ? <ActivityIndicator color="white" /> : <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>{t('common.save')}</Text>}
            </Pressable>
          </View>
        )}
      </ScrollView>

      <OcrScanModal
        visible={ocrVisible}
        loading={ocrLoading}
        error={ocrError}
        result={ocrResult}
        onClose={() => setOcrVisible(false)}
        onConfirm={applyOcrResult}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: 20,
    paddingBottom: 60,
  },
  segmentWrap: {
    borderRadius: 12,
    padding: 4,
    marginBottom: 24,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  uploadBig: {
    width: '100%',
    height: 240,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  form: {
    gap: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: -8,
  },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
  },
  input: {
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  saveBtn: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  }
});
