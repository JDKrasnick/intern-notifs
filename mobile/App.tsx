import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Animated,
  AppState,
  BackHandler,
  Easing,
  FlatList,
  InteractionManager,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  SafeAreaView,
  ScrollView,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Notifications from "expo-notifications";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons } from "@expo/vector-icons";
import { ApiError, api, authenticatedRead, responseCache, sessionStorage } from "./src/api";
import { appendCatalogPage, type CatalogPage } from "./src/catalog";
import { confirmEmail, restoreSession, signIn, signUp } from "./src/auth";
import {
  clearApplicationFollowUp,
  notifyApplicationProgress,
  registerForJobAlerts,
  scheduleApplicationFollowUp,
} from "./src/notifications";
import {
  destinationFromNotification,
  destinationFromUrl,
  freshnessLabel,
  isNewJob,
  jobDetailPresentation,
  jobOpenDisposition,
  postingTimingPresentation,
  postingRecencyBadge,
  routeFailureState,
  sourcePresentation,
  validatedOfficialUrl,
  type AppDestination,
  type FilterMatchReason,
  type JobRouteState,
} from "./src/job-detail";
import { resolveApplicationJob, type ApplicationJobSummary } from "./src/application";
import {
  appSettingsPayload,
  jobPreferencesPayload,
  settingsDraftSyncPlan,
  settingsDestinations,
  type SettingsDestination,
  type SettingsDraftRevisions,
} from "./src/settings";

type Job = {
  jobId: string;
  company: string;
  title: string;
  location: string;
  season: string;
  applyUrl: string;
  compensation: { raw: string };
  employerCategory?: EmployerCategory;
  requirements?: { requiresUsCitizenship: boolean; advancedDegreeRequired: boolean };
  open: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  applicationUrlValidatedAt?: string;
  invalidApplicationUrl?: string;
  sourceReferences: Array<{
    sourceId: string;
    sourceUrl: string;
    postedAt?: string;
    providerTimestamp?: { value: string; semantics: "published" | "updated" };
  }>;
};
type EmployerCategory = "faang" | "startup" | "normal";
type CatalogSource = "all" | "direct" | "community" | "corroborated";
type Application = {
  applicationId: string;
  jobId: string;
  status: string;
  notes?: string;
  job?: ApplicationJobSummary;
};
type LaunchInbox = {
  jobs: Job[];
  total: number;
  hasMore: boolean;
  previousOpenedAt: string | null;
  openedAt: string;
};
type CatalogCache = CatalogPage<Job>;
type RoleSection = { kind: "new" | "seen" | "all"; data: Job[] };
type CompanyCoverageState = "direct-published" | "direct-shadow" | "feed-observed" | "candidate-only";
type CompanyCoverageResponse = {
  generatedAt: string;
  methodology: string;
  counts: {
    companies: number;
    internshipObserved: number;
    directPublished: number;
    directShadow: number;
    feedObservedOnly: number;
    candidateOnly: number;
    activeListingObservations: number;
  };
  matchedCompanies: number;
  companies: Array<{
    companyId: string;
    displayName: string;
    coverageState: CompanyCoverageState;
    activeListingCount: number;
    directProviders: Array<"greenhouse" | "lever">;
  }>;
};
type JobFilter = {
  includeCategories?: string[];
  includeKeywords?: string[];
  excludeCategories?: string[];
  excludeKeywords?: string[];
  includeEmployerCategories?: EmployerCategory[];
  excludeEmployerCategories?: EmployerCategory[];
  excludeUsCitizenshipRequired?: boolean;
  excludeAdvancedDegreeRequired?: boolean;
};
type PushPreferences = {
  titleTemplate?: string;
  descriptionTemplate?: string;
  roleAbbreviations?: Record<string, string>;
};
type AlertSettings = {
  delivery: "immediate" | "daily-digest";
  quietHours?: { start: string; end: string; timezone: string };
  applicationReminders: boolean;
  followUpDays: number;
};
type Preference = {
  filter: JobFilter;
  alertsEnabled: boolean;
  emailAlertsEnabled?: boolean;
  onboardingComplete: boolean;
  alertSettings?: AlertSettings;
  push?: PushPreferences;
};
const defaultAlertSettings: AlertSettings = {
  delivery: "immediate",
  applicationReminders: true,
  followUpDays: 7,
};
const catalogCacheKey = "internnotifs.open-catalog.v2";
const hiddenRolesCacheKey = "internnotifs.hidden-roles.v1";
const nextApplicationStatuses: Record<string, Application["status"]> = {
  saved: "applied",
  applied: "assessment",
  assessment: "interview",
  interview: "offer",
  offer: "offer",
  rejected: "rejected",
  withdrawn: "withdrawn",
};
const categories = ["ai-ml", "grad", "swe", "quant", "product", "design"];
const employerCategoryLabels: Record<EmployerCategory, string> = {
  faang: "FAANG",
  startup: "Startups",
  normal: "Normal",
};
const pushPlaceholders = [
  "{title}",
  "{shortTitle}",
  "{company}",
  "{location}",
  "{season}",
  "{compensation}",
  "{compensationDetail}",
  "{focus}",
  "{posted}",
  "{postedDetail}",
  "{source}",
  "{url}",
];
const colors = {
  canvas: "#F2F2F7",
  surface: "#FFFFFF",
  ink: "#1C1C1E",
  body: "#3A3A3C",
  muted: "#6C6C70",
  placeholder: "#475569",
  border: "#D1D1D6",
  separator: "#E5E5EA",
  signal: "#0E7490",
  signalSoft: "#E6F6F8",
  signalGlow: "#67E8F9",
  onDark: "#FFFFFF",
  overlay: "rgba(15, 23, 42, 0.44)",
  dangerSoft: "#FEF1F0",
  dangerBorder: "#F2AAA4",
  successSoft: "#ECFDF3",
  successBorder: "#86D6A5",
  danger: "#B42318",
};
const MotionAllowedContext = createContext(false);

function useMotionAllowed() {
  const [motionAllowed, setMotionAllowed] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((reduceMotion) => {
        if (mounted) setMotionAllowed(!reduceMotion);
      })
      .catch(() => {
        if (mounted) setMotionAllowed(true);
      });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (reduceMotion) => setMotionAllowed(!reduceMotion),
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return motionAllowed;
}

async function openOfficialApplication(url: string) {
  if (!/^https:\/\//i.test(url)) {
    Alert.alert(
      "Application link unavailable",
      "This role does not have a valid official application link yet.",
    );
    return;
  }

  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    Alert.alert(
      "Could not open application",
      "Please try again or open the employer's site from another device.",
    );
  }
}

function JobSource({ source }: { source: ReturnType<typeof sourcePresentation> }) {
  const icon = source.primary.startsWith("Official")
    ? "shield-checkmark-outline"
    : source.primary === "Community listing"
      ? "people-outline"
      : "help-circle-outline";
  return (
    <View style={styles.jobSourceRow}>
      <Ionicons name={icon} size={14} color={colors.muted} />
      <Text style={styles.jobSourceText}>{source.primary}</Text>
      {source.corroboration ? <Text style={styles.jobSourceCorroboration}>Community corroborated</Text> : null}
    </View>
  );
}

function openAppSettings() {
  void Linking.openSettings().catch(() => {
    Alert.alert("Could not open Settings", "Open your device settings and select InternNotifs.");
  });
}

function showNotificationPermissionHelp() {
  Alert.alert(
    "Notifications are off",
    "Enable notifications for InternNotifs in your device settings, then try again.",
    [
      { text: "Not now", style: "cancel" },
      { text: "Open Settings", onPress: openAppSettings },
    ],
  );
}

function hasGreenhouseQuickApply(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "boards.greenhouse.io"
      || host.endsWith(".boards.greenhouse.io")
      || host === "job-boards.greenhouse.io"
      || host.endsWith(".job-boards.greenhouse.io");
  } catch {
    return false;
  }
}

function JobCard({
  job,
  onOpen,
  applicationStatus,
  isNew = false,
  onSaveForWeb,
  isSavingForWeb = false,
  onHideLocally,
}: {
  job: Job;
  onOpen: () => void;
  applicationStatus?: string;
  isNew?: boolean;
  /** Saving is account-backed, so the same role is available in the web app. */
  onSaveForWeb?: () => void;
  isSavingForWeb?: boolean;
  onHideLocally?: () => void;
}) {
  const motionAllowed = useContext(MotionAllowedContext);
  const source = sourcePresentation(job.sourceReferences);
  const translateX = useRef(new Animated.Value(0)).current;
  const canSaveForWeb = Boolean(onSaveForWeb) && !applicationStatus && !isSavingForWeb;
  const canHideLocally = Boolean(onHideLocally);
  const postingTiming = postingTimingPresentation(job.sourceReferences, job.firstSeenAt);
  const recencyBadge = postingRecencyBadge(isNew, postingTiming);
  const resetPosition = () => {
    if (!motionAllowed) {
      translateX.setValue(0);
      return;
    }
    Animated.spring(translateX, {
      toValue: 0,
      friction: 9,
      tension: 130,
      useNativeDriver: true,
    }).start();
  };
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          ((canSaveForWeb && gesture.dx < -8) || (canHideLocally && gesture.dx > 8))
          && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderMove: (_, gesture) => {
          translateX.setValue(
            Math.max(canSaveForWeb ? -116 : 0, Math.min(canHideLocally ? 116 : 0, gesture.dx)),
          );
        },
        onPanResponderRelease: (_, gesture) => {
          const shouldSave = canSaveForWeb && (gesture.dx < -84 || gesture.vx < -0.7);
          const shouldHide = canHideLocally && (gesture.dx > 84 || gesture.vx > 0.7);
          if (!shouldSave && !shouldHide) {
            resetPosition();
            return;
          }
          if (shouldSave) onSaveForWeb?.();
          if (!motionAllowed) {
            translateX.setValue(0);
            if (shouldHide) onHideLocally?.();
            return;
          }
          Animated.sequence([
            Animated.timing(translateX, {
              toValue: shouldSave ? -108 : 108,
              duration: 100,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.delay(120),
          ]).start(() => {
            if (shouldHide) onHideLocally?.();
            else resetPosition();
          });
        },
        onPanResponderTerminate: resetPosition,
      }),
    [canHideLocally, canSaveForWeb, motionAllowed, onHideLocally, onSaveForWeb, translateX],
  );
  const saveActionProgress = translateX.interpolate({
    inputRange: [-108, -36, 0],
    outputRange: [1, 0.32, 0],
    extrapolate: "clamp",
  });
  const hideActionProgress = translateX.interpolate({
    inputRange: [0, 36, 108],
    outputRange: [0, 0.32, 1],
    extrapolate: "clamp",
  });

  return (
    <View style={styles.swipeCard}>
      {canSaveForWeb || isSavingForWeb ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.swipeSaveAction, { opacity: saveActionProgress }]}
        >
          <Ionicons name="bookmark" size={20} color={colors.onDark} />
          <Text style={styles.swipeSaveActionText}>{isSavingForWeb ? "Saving…" : "Save"}</Text>
        </Animated.View>
      ) : null}
      {canHideLocally ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.swipeHideAction, { opacity: hideActionProgress }]}
        >
          <Ionicons name="eye-off-outline" size={20} color={colors.onDark} />
          <Text style={styles.swipeHideActionText}>Hide</Text>
        </Animated.View>
      ) : null}
      <Animated.View
        {...(canSaveForWeb || canHideLocally ? panResponder.panHandlers : {})}
        style={{ transform: [{ translateX }] }}
      >
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`${recencyBadge ? `${recencyBadge} role, ` : ""}${job.title} at ${job.company}, ${job.location}, ${postingTiming.summary}, ${source.primary}${source.corroboration ? ", corroborated by a community listing" : ""}${applicationStatus ? `, ${applicationStatus}` : ""}`}
          accessibilityHint={
            canSaveForWeb && canHideLocally
              ? "Swipe left to save this role for the web app, or swipe right to hide it on this device."
              : canSaveForWeb
                ? "Swipe left to save this role and apply later in the web app."
                : canHideLocally
                  ? "Swipe right to hide this role on this device."
                  : undefined
          }
          accessibilityActions={
            [
              ...(canSaveForWeb ? [{ name: "save", label: "Save for web" }] : []),
              ...(canHideLocally ? [{ name: "hide", label: "Hide on this device" }] : []),
            ]
          }
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "save") onSaveForWeb?.();
            if (event.nativeEvent.actionName === "hide") onHideLocally?.();
          }}
          style={[styles.card, styles.swipeCardSurface]}
          onPress={onOpen}
        >
          <View style={styles.jobCompanyRow}>
            <Text style={styles.company}>{job.company}</Text>
            {recencyBadge ? (
              <View style={styles.newSpark} accessibilityLabel={`${recencyBadge} role`}>
                <Ionicons name="sparkles-outline" size={13} color={colors.signal} />
                <Text style={styles.newSparkText}>{recencyBadge}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.title}>{job.title}</Text>
          <Text style={styles.muted}>
            {job.location} · {job.season}
          </Text>
          <JobSource source={source} />
          <Text style={styles.postingTiming}>{postingTiming.summary}</Text>
          {!job.open ? <Text style={styles.closedStatus}>Closed</Text> : null}
          {job.compensation.raw ? (
            <Text style={styles.pay}>{job.compensation.raw}</Text>
          ) : null}
          {applicationStatus ? (
            <View style={styles.jobApplicationStatus}>
              <Text style={styles.jobApplicationStatusText}>{applicationStatus.toUpperCase()}</Text>
            </View>
          ) : null}
          <View style={styles.jobCardAction}>
            <Text style={styles.jobCardActionText}>View role</Text>
            <Text style={styles.jobCardActionArrow}>›</Text>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

function NewRoleCard({
  job,
  onOpen,
  applicationStatus,
  index,
  onSaveForWeb,
  isSavingForWeb,
  onHideLocally,
}: {
  job: Job;
  onOpen: () => void;
  applicationStatus?: string;
  index: number;
  onSaveForWeb?: () => void;
  isSavingForWeb?: boolean;
  onHideLocally?: () => void;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;
  const motionAllowed = useContext(MotionAllowedContext);

  useEffect(() => {
    if (!motionAllowed) {
      opacity.setValue(1);
      lift.setValue(0);
      glow.setValue(0);
      return;
    }
    opacity.setValue(0);
    lift.setValue(8);
    glow.setValue(0);
    const animation = Animated.sequence([
      Animated.delay(Math.min(index, 4) * 80),
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.spring(lift, { toValue: 0, friction: 9, tension: 100, useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(glow, { toValue: 0.18, duration: 160, useNativeDriver: true }),
          Animated.timing(glow, { toValue: 0, duration: 420, useNativeDriver: true }),
        ]),
      ]),
    ]);
    animation.start();
    return () => animation.stop();
  }, [glow, index, lift, motionAllowed, opacity]);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY: lift }] }}>
      <JobCard
        job={job}
        onOpen={onOpen}
        applicationStatus={applicationStatus}
        isNew
        onSaveForWeb={onSaveForWeb}
        isSavingForWeb={isSavingForWeb}
        onHideLocally={onHideLocally}
      />
      <Animated.View pointerEvents="none" style={[styles.newRoleGlow, { opacity: glow }]} />
    </Animated.View>
  );
}

function JobDetailSheet({
  job,
  signedIn,
  matchedReasons = [],
  exclusionsApplied = false,
  routeState = "idle",
  onDismiss,
  onModalDismissed = () => undefined,
  onRetry = () => undefined,
  onApply,
  onOpenListing,
}: {
  job: Job | null;
  signedIn: boolean;
  matchedReasons?: FilterMatchReason[];
  exclusionsApplied?: boolean;
  routeState?: JobRouteState;
  onDismiss: () => void;
  onModalDismissed?: () => void;
  onRetry?: () => void;
  onApply: (job: Job) => void;
  onOpenListing: (job: Job) => void;
}) {
  const motionAllowed = useContext(MotionAllowedContext);
  const sheetOffset = useRef(new Animated.Value(800)).current;
  const displayedJob = useRef<Job | null>(null);
  const pendingAction = useRef<{ job: Job; kind: "apply" | "listing" } | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const presentation = jobDetailPresentation(Boolean(job), routeState);
  const visible = presentation.visible;

  if (job) displayedJob.current = job;

  useEffect(() => {
    if (!visible) {
      sheetOffset.setValue(800);
      return;
    }

    sheetOffset.setValue(800);
    if (!motionAllowed) {
      sheetOffset.setValue(0);
      return;
    }

    const animation = Animated.timing(sheetOffset, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [motionAllowed, sheetOffset, visible]);

  const role = job ?? displayedJob.current;
  const details = [role?.location, role?.season, role?.compensation.raw]
    .filter(Boolean)
    .join(" · ");
  const actionLabel = !role?.open
    ? "View official listing"
    : signedIn
      ? "Apply on official site"
      : "Open official application";
  const greenhouseQuickApply = role ? hasGreenhouseQuickApply(role.applyUrl) : false;
  const source = sourcePresentation(role?.sourceReferences ?? []);
  const postingTiming = role
    ? postingTimingPresentation(role.sourceReferences, role.firstSeenAt)
    : undefined;
  const closedListingUrl = role && !role.open ? validatedOfficialUrl(role) : undefined;
  return (
    <Modal
      animationType="none"
      transparent
      visible={visible}
      onRequestClose={onDismiss}
      onDismiss={() => {
        const action = pendingAction.current;
        pendingAction.current = null;
        displayedJob.current = null;
        setHandoffPending(false);
        if (action) {
          if (action.kind === "apply") onApply(action.job);
          else onOpenListing(action.job);
        }
        onModalDismissed();
      }}
      statusBarTranslucent
    >
      <View style={styles.sheetOverlay}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Close role details"
          style={styles.sheetDismissArea}
          onPress={onDismiss}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[styles.jobSheet, { transform: [{ translateY: sheetOffset }] }]}
        >
          <View style={styles.sheetHandle} />
          {presentation.content === "route" ? (
            <JobRouteStatusContent state={routeState} onDismiss={onDismiss} onRetry={onRetry} />
          ) : role ? (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.sheetContent}>
              <Text style={styles.sheetEyebrow}>{role.open ? "Role details" : "Closed role"}</Text>
              <Text style={styles.sheetTitle}>{role.title}</Text>
              <Text style={styles.sheetCompany}>{role.company}</Text>
              <Text style={styles.sheetDetail}>{details}</Text>
              <View style={styles.sheetTrustBlock}>
                <Text style={styles.sheetTrustPrimary}>{source.primary}</Text>
                {source.corroboration ? <Text style={styles.sheetTrustSecondary}>{source.corroboration}</Text> : null}
                {postingTiming ? <Text style={styles.sheetTrustSecondary}>{postingTiming.detail}</Text> : null}
                <Text style={styles.sheetTrustSecondary}>{freshnessLabel(role.lastSeenAt)}</Text>
              </View>
              {matchedReasons.length ? (
                <View style={styles.sheetMatchBlock} accessibilityLabel={`Matched filters: ${matchedReasons.map((reason) => reason.label).join(", ")}${exclusionsApplied ? ". Your exclusions were also applied." : ""}`}>
                  <Text style={styles.sheetMatchTitle}>Why you received this alert</Text>
                  <Text style={styles.sheetMatchText}>{matchedReasons.map((reason) => reason.label).join(" · ")}</Text>
                  {exclusionsApplied ? <Text style={styles.sheetMatchHelper}>Your exclusions were also applied.</Text> : null}
                </View>
              ) : null}
              {!role.open ? (
                <View style={styles.sheetClosedNotice}>
                  <Text style={styles.sheetClosedText}>Applications for this role are closed.</Text>
                </View>
              ) : null}
              <View style={styles.sheetActions}>
                {role.open ? (
                  <ApplyNowButton
                    disabled={handoffPending}
                    label={greenhouseQuickApply ? "Open Greenhouse Quick Apply" : actionLabel}
                    hint={
                      greenhouseQuickApply
                        ? "Opens the official Greenhouse application. If this employer enables Quick Apply, MyGreenhouse can fill details you have saved there."
                        : "Opens the official employer form and saves this role to To Apply."
                    }
                    onPress={() => startRoleAction("apply")}
                  />
                ) : null}
                {role.open || closedListingUrl ? (
                  <ActionButton
                    label={role.open ? "Read the official listing first" : "View official listing"}
                    variant="secondary"
                    disabled={handoffPending}
                    onPress={() => startRoleAction("listing")}
                  />
                ) : null}
                <ActionButton label="Not now" variant="secondary" onPress={onDismiss} />
              </View>
              <Text style={styles.sheetHelper}>
                {!role.open
                  ? closedListingUrl
                    ? "The last validated official listing remains available for reference."
                    : "The official listing link is no longer verified, so it has been removed."
                  : greenhouseQuickApply
                  ? "If this employer enables Quick Apply, MyGreenhouse can fill the details you have saved there. Review every answer before submitting."
                  : signedIn
                  ? "Apply now opens the employer form and saves this role to To Apply."
                  : "You’ll complete the employer’s application in your browser."}
              </Text>
            </ScrollView>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );

  function startRoleAction(kind: "apply" | "listing") {
    if (!role || pendingAction.current) return;
    pendingAction.current = { job: role, kind };
    setHandoffPending(true);
    onDismiss();
    // Android does not fire Modal.onDismiss. Let its modal teardown finish
    // before opening the Custom Tab instead.
    if (Platform.OS !== "ios") {
      InteractionManager.runAfterInteractions(() => {
        const action = pendingAction.current;
        pendingAction.current = null;
        displayedJob.current = null;
        setHandoffPending(false);
        if (action) {
          if (action.kind === "apply") onApply(action.job);
          else onOpenListing(action.job);
        }
      });
    }
  }
}

function ApplyNowButton({
  onPress,
  disabled = false,
  label = "Open official application",
  hint = "Opens the official employer form",
}: {
  onPress: () => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.applyNowButton, disabled && styles.actionButtonDisabled]}
    >
      <Text style={styles.applyNowTitle}>{label}</Text>
      <Ionicons name="open-outline" size={19} color={colors.onDark} style={styles.applyNowArrow} />
    </TouchableOpacity>
  );
}

function JobRouteStatusContent({
  state,
  onDismiss,
  onRetry,
}: {
  state: JobRouteState;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  if (state === "idle") return null;
  const loading = state === "loading";
  const missing = state === "missing";
  return (
    <View style={styles.sheetContent}>
      {loading ? (
        <View accessibilityRole="progressbar" accessibilityLabel="Loading role details">
          <Text style={styles.sheetEyebrow}>Role details</Text>
          <Skeleton width={250} height={24} />
          <View style={styles.skeletonGap12} />
          <Skeleton width={180} />
          <View style={styles.skeletonGap8} />
          <Skeleton width={220} />
        </View>
      ) : (
        <>
          <Text style={styles.sheetEyebrow}>{missing ? "Role unavailable" : "Couldn’t load role"}</Text>
          <Text style={styles.sheetTitle}>{missing ? "This role is no longer available." : "Check your connection and try again."}</Text>
          <Text style={styles.sheetHelper}>{missing ? "It may have been removed from the catalog." : "Your alert and saved filters are unchanged."}</Text>
          <View style={styles.sheetActions}>
            {!missing ? <ActionButton label="Try again" onPress={onRetry} /> : null}
            <ActionButton label="Back to roles" variant="secondary" onPress={onDismiss} />
          </View>
        </>
      )}
      </View>
  );
}

function EmployerCategoryFilter({
  selected,
  onChange,
}: {
  selected: EmployerCategory | "all";
  onChange: (value: EmployerCategory | "all") => void;
}) {
  const options: Array<EmployerCategory | "all"> = ["all", "faang", "startup", "normal"];
  return (
    <View style={styles.companyFilter} accessibilityRole="radiogroup">
      {options.map((option) => (
        <TouchableOpacity
          key={option}
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === option }}
          style={[styles.chip, selected === option && styles.chipOn]}
          onPress={() => onChange(option)}
        >
          <Text style={[styles.chipLabel, selected === option && styles.chipLabelOn]}>
            {option === "all" ? "All" : employerCategoryLabels[option]}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function JobStatusFilter({
  status,
  onChange,
}: {
  status: "open" | "closed";
  onChange: (value: "open" | "closed") => void;
}) {
  return (
    <View style={styles.companyFilter} accessibilityRole="radiogroup">
      {(["open", "closed"] as const).map((option) => (
        <TouchableOpacity
          key={option}
          accessibilityRole="radio"
          accessibilityState={{ selected: status === option }}
          style={[styles.chip, status === option && styles.chipOn]}
          onPress={() => onChange(option)}
        >
          <Text style={[styles.chipLabel, status === option && styles.chipLabelOn]}>
            {option === "open" ? "Open" : "Closed"}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function RequirementFilter({
  hideUsCitizenshipRequired,
  hideAdvancedDegreeRequired,
  onHideUsCitizenshipRequiredChange,
  onHideAdvancedDegreeRequiredChange,
}: {
  hideUsCitizenshipRequired: boolean;
  hideAdvancedDegreeRequired: boolean;
  onHideUsCitizenshipRequiredChange: (value: boolean) => void;
  onHideAdvancedDegreeRequiredChange: (value: boolean) => void;
}) {
  const options = [
    { key: "citizenship", label: "Hide U.S. citizenship", selected: hideUsCitizenshipRequired, onPress: () => onHideUsCitizenshipRequiredChange(!hideUsCitizenshipRequired) },
    { key: "advanced-degree", label: "Hide advanced degree", selected: hideAdvancedDegreeRequired, onPress: () => onHideAdvancedDegreeRequiredChange(!hideAdvancedDegreeRequired) },
  ];
  return (
    <View style={styles.companyFilter}>
      {options.map((option) => (
        <TouchableOpacity
          key={option.key}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: option.selected }}
          style={[styles.chip, option.selected && styles.chipOn]}
          onPress={option.onPress}
        >
          <Text style={[styles.chipLabel, option.selected && styles.chipLabelOn]}>{option.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function RoleFilters({
  expanded,
  onToggle,
  employerFilter,
  onEmployerFilterChange,
  jobStatus,
  onJobStatusChange,
  sourceFilter,
  onSourceFilterChange,
  hideUsCitizenshipRequired,
  hideAdvancedDegreeRequired,
  onHideUsCitizenshipRequiredChange,
  onHideAdvancedDegreeRequiredChange,
}: {
  expanded: boolean;
  onToggle: () => void;
  employerFilter: EmployerCategory | "all";
  onEmployerFilterChange: (value: EmployerCategory | "all") => void;
  jobStatus: "open" | "closed";
  onJobStatusChange: (value: "open" | "closed") => void;
  sourceFilter: CatalogSource;
  onSourceFilterChange: (value: CatalogSource) => void;
  hideUsCitizenshipRequired: boolean;
  hideAdvancedDegreeRequired: boolean;
  onHideUsCitizenshipRequiredChange: (value: boolean) => void;
  onHideAdvancedDegreeRequiredChange: (value: boolean) => void;
}) {
  const activeFilterCount = [
    employerFilter !== "all",
    jobStatus !== "open",
    sourceFilter !== "all",
    hideUsCitizenshipRequired,
    hideAdvancedDegreeRequired,
  ].filter(Boolean).length;
  const clearFilters = () => {
    onEmployerFilterChange("all");
    onJobStatusChange("open");
    onSourceFilterChange("all");
    onHideUsCitizenshipRequiredChange(false);
    onHideAdvancedDegreeRequiredChange(false);
  };
  return (
    <View style={styles.filterRegion}>
      <View style={styles.filterBar}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={styles.filterToggle}
        >
          <Text style={styles.filterToggleText}>
            {expanded ? "Hide filters" : activeFilterCount ? `Filters · ${activeFilterCount}` : "Filter roles"}
          </Text>
          <Text style={styles.filterToggleGlyph}>{expanded ? "−" : "+"}</Text>
        </TouchableOpacity>
        {activeFilterCount ? (
          <TouchableOpacity accessibilityRole="button" onPress={clearFilters} style={styles.clearFilters}>
            <Text style={styles.clearFiltersText}>Clear</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {expanded ? (
        <View style={styles.filterPanel}>
          <Text style={styles.filterLabel}>Company type</Text>
          <EmployerCategoryFilter selected={employerFilter} onChange={onEmployerFilterChange} />
          <Text style={styles.filterLabel}>Availability</Text>
          <JobStatusFilter status={jobStatus} onChange={onJobStatusChange} />
          <Text style={styles.filterLabel}>Source</Text>
          <View style={styles.companyFilter}>
            {([['all', 'All'], ['direct', 'Direct'], ['community', 'Community'], ['corroborated', 'Direct + community']] as const).map(([value, label]) => (
              <TouchableOpacity key={value} accessibilityRole="radio" accessibilityState={{ selected: sourceFilter === value }} style={[styles.chip, sourceFilter === value && styles.chipOn]} onPress={() => onSourceFilterChange(value)}>
                <Text style={[styles.chipLabel, sourceFilter === value && styles.chipLabelOn]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.filterLabel}>Requirements</Text>
          <RequirementFilter
            hideUsCitizenshipRequired={hideUsCitizenshipRequired}
            hideAdvancedDegreeRequired={hideAdvancedDegreeRequired}
            onHideUsCitizenshipRequiredChange={onHideUsCitizenshipRequiredChange}
            onHideAdvancedDegreeRequiredChange={onHideAdvancedDegreeRequiredChange}
          />
        </View>
      ) : null}
      <CompanyCoverageDisclosure />
    </View>
  );
}

const coverageStateLabels: Record<CompanyCoverageState, string> = {
  "direct-published": "Direct source",
  "direct-shadow": "Direct source in review",
  "feed-observed": "Internship observed",
  "candidate-only": "Company candidate",
};

function CompanyCoverageDisclosure() {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [coverage, setCoverage] = useState<CompanyCoverageResponse>();
  const [error, setError] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let active = true;
    const timeout = setTimeout(() => {
      const normalized = query.trim();
      void api<CompanyCoverageResponse>(
        `/coverage?limit=12${normalized ? `&q=${encodeURIComponent(normalized)}` : ""}`,
        "",
      )
        .then((response) => {
          if (active) {
            setCoverage(response);
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    }, query.trim() ? 250 : 0);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [query]);
  if (Platform.OS !== "web") return null;
  return (
    <View style={styles.coverageRegion}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.coverageToggle}
      >
        <View>
          <Text style={styles.coverageToggleTitle}>Company coverage</Text>
          <Text style={styles.coverageToggleSummary}>
            {coverage
              ? `${coverage.counts.internshipObserved.toLocaleString()} companies with current internship evidence`
              : error
                ? "Coverage unavailable"
                : "Loading coverage…"}
          </Text>
        </View>
        <Text style={styles.filterToggleGlyph}>{expanded ? "−" : "+"}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.coveragePanel}>
          {coverage ? (
            <View style={styles.coverageStats}>
              <View>
                <Text style={styles.coverageStatValue}>{coverage.counts.activeListingObservations.toLocaleString()}</Text>
                <Text style={styles.coverageStatLabel}>listing observations</Text>
              </View>
              <View>
                <Text style={styles.coverageStatValue}>{coverage.counts.directPublished}</Text>
                <Text style={styles.coverageStatLabel}>direct sources</Text>
              </View>
              <View>
                <Text style={styles.coverageStatValue}>{coverage.counts.directShadow}</Text>
                <Text style={styles.coverageStatLabel}>in review</Text>
              </View>
            </View>
          ) : null}
          <Text style={styles.coverageExplanation}>
            Search the tracked company universe. Community-feed evidence and reviewed employer sources are labeled separately.
          </Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            accessibilityLabel="Search company coverage"
            placeholder="Search tracked companies"
            placeholderTextColor={colors.placeholder}
            style={styles.coverageSearch}
          />
          {error ? (
            <Text style={styles.coverageExplanation}>We couldn’t load coverage right now.</Text>
          ) : coverage?.companies.length ? (
            <View style={styles.coverageResults}>
              {coverage.companies.map((company) => (
                <View key={company.companyId} style={styles.coverageRow}>
                  <View style={styles.coverageCompanyCopy}>
                    <Text style={styles.coverageCompany}>{company.displayName}</Text>
                    <Text style={styles.coverageCompanyState}>
                      {coverageStateLabels[company.coverageState]}
                      {company.directProviders.length ? ` · ${company.directProviders.join(", ")}` : ""}
                    </Text>
                  </View>
                  <Text style={styles.coverageRoleCount}>
                    {company.activeListingCount ? `${company.activeListingCount} listing${company.activeListingCount === 1 ? "" : "s"}` : "No current listings"}
                  </Text>
                </View>
              ))}
            </View>
          ) : coverage && query.trim() ? (
            <Text style={styles.coverageExplanation}>No tracked company matches that search.</Text>
          ) : null}
          {coverage ? (
            <Text style={styles.coverageAsOf}>
              Snapshot {new Date(coverage.generatedAt).toLocaleDateString()}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function TabNavigation({
  active,
  onChange,
  rail = false,
}: {
  active: "feed" | "saved" | "profile";
  onChange: (tab: "feed" | "saved" | "profile") => void;
  rail?: boolean;
}) {
  const tabs = [
    { key: "feed", label: "Roles", icon: "briefcase-outline", activeIcon: "briefcase" },
    { key: "saved", label: "Saved", icon: "bookmark-outline", activeIcon: "bookmark" },
    { key: "profile", label: "Profile", icon: "person-outline", activeIcon: "person" },
  ] as const;
  return (
    <View style={[styles.nav, rail && styles.navRail]} accessibilityRole="tablist">
      {tabs.map((item) => {
        const selected = active === item.key;
        return (
          <TouchableOpacity
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={item.label}
            onPress={() => onChange(item.key)}
            style={[styles.navItem, rail && styles.navRailItem]}
          >
            <Ionicons
              name={selected ? item.activeIcon : item.icon}
              size={22}
              color={selected ? colors.ink : colors.muted}
            />
            <Text style={[styles.navLabel, selected && styles.navLabelActive]}>
              {item.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  variant = "primary",
  compact = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  compact?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.actionButton,
        variant === "secondary" && styles.actionButtonSecondary,
        variant === "danger" && styles.actionButtonDanger,
        compact && styles.actionButtonCompact,
        disabled && styles.actionButtonDisabled,
      ]}
    >
      <Text
        style={[
          styles.actionButtonText,
          variant === "secondary" && styles.actionButtonTextSecondary,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <View style={styles.pageHeading}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.pageTitle}>{title}</Text>
      {description ? <Text style={styles.pageDescription}>{description}</Text> : null}
    </View>
  );
}

function EmptyState({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyCopy}>{description}</Text>
    </View>
  );
}

type SaveFeedbackState =
  | { kind: "idle" }
  | { kind: "saving"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function SaveFeedback({
  state,
  onRetry,
}: {
  state: SaveFeedbackState;
  onRetry?: () => void;
}) {
  if (state.kind === "idle") return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.saveFeedback,
        state.kind === "success" && styles.saveFeedbackSuccess,
        state.kind === "error" && styles.saveFeedbackError,
      ]}
    >
      <Text style={styles.saveFeedbackText}>{state.message}</Text>
      {state.kind === "error" && onRetry ? (
        <TouchableOpacity accessibilityRole="button" onPress={onRetry}>
          <Text style={styles.saveFeedbackRetry}>Try again</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function HiddenRolePlaceholder({ onUndo }: { onUndo: () => void }) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.hiddenRolePlaceholder}>
      <Text style={styles.hiddenRolePlaceholderText}>Role hidden on this device</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Undo hide" onPress={onUndo}>
        <Text style={styles.hiddenRolePlaceholderUndo}>Undo</Text>
      </TouchableOpacity>
    </View>
  );
}

function ChoiceOption({
  label,
  description,
  selected,
  onPress,
}: {
  label: string;
  description: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.choiceOption, selected && styles.choiceOptionSelected]}
    >
      <View style={styles.choiceCopy}>
        <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>
          {label}
        </Text>
        <Text style={styles.choiceDescription}>{description}</Text>
      </View>
      <View style={[styles.choiceMark, selected && styles.choiceMarkSelected]}>
        {selected ? <View style={styles.choiceMarkDot} /> : null}
      </View>
    </TouchableOpacity>
  );
}

function Skeleton({ width, height = 14 }: { width: number; height?: number }) {
  return (
    <View
      style={[styles.skeleton, { width, height, borderRadius: height / 2 }]}
    />
  );
}

function JobCardSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton width={104} height={12} />
      <View style={styles.skeletonGap8} />
      <Skeleton width={236} height={18} />
      <View style={styles.skeletonGap8} />
      <Skeleton width={174} height={14} />
    </View>
  );
}

function LoadingRoleCard({ index }: { index: number }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const motionAllowed = useContext(MotionAllowedContext);

  useEffect(() => {
    if (!motionAllowed) {
      opacity.setValue(1);
      lift.setValue(0);
      return;
    }
    opacity.setValue(0);
    lift.setValue(10);
    const animation = Animated.sequence([
      Animated.delay(index * 100),
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 240, useNativeDriver: true }),
        Animated.spring(lift, { toValue: 0, friction: 10, tension: 100, useNativeDriver: true }),
      ]),
    ]);
    animation.start();
    return () => animation.stop();
  }, [index, lift, motionAllowed, opacity]);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY: lift }] }}>
      <JobCardSkeleton />
    </Animated.View>
  );
}

function launchInterval(previousOpenedAt: string | null) {
  if (!previousOpenedAt) return "your last visit";
  const date = new Date(previousOpenedAt);
  if (Number.isNaN(date.valueOf())) return "your last visit";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function LaunchInbox({
  inbox,
  onOpen,
  onViewAll,
  applicationStatuses,
  onSaveForWeb,
  savingJobIds,
  hiddenJobIds,
  onHideLocally,
  hiddenFeedbackJob,
  onUndoHide,
}: {
  inbox: LaunchInbox;
  onOpen: (job: Job) => void;
  onViewAll: () => void;
  applicationStatuses: Map<string, string>;
  onSaveForWeb: (job: Job) => void;
  savingJobIds: Set<string>;
  hiddenJobIds: Set<string>;
  onHideLocally: (job: Job) => void;
  hiddenFeedbackJob?: Job;
  onUndoHide: () => void;
}) {
  const visibleJobs = inbox.jobs.filter(
    (job) => !hiddenJobIds.has(job.jobId) || hiddenFeedbackJob?.jobId === job.jobId,
  );
  return (
    <FlatList
      style={styles.list}
      data={visibleJobs}
      keyExtractor={(job) => job.jobId}
      contentContainerStyle={styles.feedListContent}
      ListHeaderComponent={
        <View style={styles.inboxHeader}>
          <Text style={styles.eyebrow}>Your radar</Text>
          <Text accessibilityLabel={`${visibleJobs.length} new matches`} style={styles.inboxCount}>
            {visibleJobs.length}
          </Text>
          <Text style={styles.inboxTitle}>new matches</Text>
          <Text style={styles.inboxDescription}>
            Matched your alerts since {launchInterval(inbox.previousOpenedAt)}
          </Text>
          {inbox.hasMore ? (
            <Text style={styles.inboxOverflow}>Showing the newest 50.</Text>
          ) : null}
          <TouchableOpacity
            accessibilityRole="button"
            onPress={onViewAll}
            style={styles.inboxViewAll}
          >
            <Text style={styles.inboxViewAllText}>View all internships</Text>
          </TouchableOpacity>
          <Text style={styles.inboxSectionLabel}>New matches</Text>
        </View>
      }
      renderItem={({ item, index }) =>
        hiddenFeedbackJob?.jobId === item.jobId ? (
          <HiddenRolePlaceholder onUndo={onUndoHide} />
        ) : (
          <NewRoleCard
            job={item}
            index={index}
            onOpen={() => onOpen(item)}
            applicationStatus={applicationStatuses.get(item.jobId)}
            onSaveForWeb={() => onSaveForWeb(item)}
            isSavingForWeb={savingJobIds.has(item.jobId)}
            onHideLocally={() => onHideLocally(item)}
          />
        )}
      ListEmptyComponent={
        <EmptyState
          eyebrow="New matches"
          title="Those roles are hidden on this device."
          description="You can restore them from Profile whenever you want."
        />
      }
      ListFooterComponent={
        visibleJobs.length ? (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={onViewAll}
            style={[styles.inboxViewAll, styles.inboxViewAllFooter]}
          >
            <Text style={styles.inboxViewAllText}>View all internships</Text>
          </TouchableOpacity>
        ) : null
      }
    />
  );
}

function CaughtUpDivider({ showSeenLabel = true }: { showSeenLabel?: boolean }) {
  return (
    <View accessibilityRole="text" accessibilityLabel="You are all caught up. Seen roles follow." style={styles.caughtUpBlock}>
      <View style={styles.caughtUpRuleRow}>
        <View style={styles.caughtUpLine} />
        <Text style={styles.caughtUpText}>You’re all caught up</Text>
        <View style={styles.caughtUpLine} />
      </View>
      {showSeenLabel ? <Text style={styles.seenRolesLabel}>Seen roles</Text> : null}
    </View>
  );
}

function CatalogInitialLoading() {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading internships" style={styles.catalogInitialLoading}>
      {[0, 1, 2].map((index) => <LoadingRoleCard key={index} index={index} />)}
    </View>
  );
}

function CatalogPaginationFooter({
  loading,
  error,
  reachedEnd,
  searching,
  onRetry,
}: {
  loading: boolean;
  error?: string;
  reachedEnd: boolean;
  searching: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <View accessibilityRole="progressbar" accessibilityLabel={searching ? "Loading more search results" : "Loading more internships"} style={styles.catalogPagination}>
        <Text style={styles.catalogPaginationText}>{searching ? "Loading more search results…" : "Loading more internships…"}</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View accessibilityRole="alert" style={styles.catalogPagination}>
        <Text style={styles.catalogPaginationText}>We couldn’t load more internships.</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try loading more internships again" onPress={onRetry} style={styles.catalogPaginationRetry}>
          <Text style={styles.catalogPaginationRetryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (reachedEnd) {
    return (
      <View accessibilityRole="text" accessibilityLabel="You have reached the end of the catalog" style={styles.catalogPagination}>
        <Text style={styles.catalogPaginationText}>You’ve reached the end</Text>
      </View>
    );
  }
  return null;
}

function AppLoadingSkeleton() {
  const { width } = useWindowDimensions();
  const usesNavigationRail = width >= 700;
  return (
    <SafeAreaView
      style={styles.screen}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading your internships"
    >
      <View style={[styles.appShell, usesNavigationRail && styles.appShellWide]}>
        {usesNavigationRail ? (
          <View style={[styles.skeletonNav, styles.skeletonNavRail]}>
            <Skeleton width={40} height={14} />
            <Skeleton width={44} height={14} />
            <Skeleton width={46} height={14} />
          </View>
        ) : null}
        <View style={styles.skeletonPage}>
          <View style={styles.loadingTitleGroup}>
            <Skeleton width={94} height={12} />
            <View style={styles.skeletonGap8} />
            <Skeleton width={168} height={28} />
          </View>
          <View style={styles.skeletonSearch} />
          <View style={styles.skeletonSection}>
            <Skeleton width={132} height={12} />
            <View style={styles.skeletonGap8} />
            <Skeleton width={248} height={14} />
          </View>
          {[0, 1, 2].map((index) => <LoadingRoleCard key={index} index={index} />)}
        </View>
        {!usesNavigationRail ? (
          <View style={styles.skeletonNav}>
            <Skeleton width={40} height={14} />
            <Skeleton width={44} height={14} />
            <Skeleton width={46} height={14} />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function AccountLoadError({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.loadErrorScreen}>
        <PageHeading
          eyebrow="Connection"
          title="We couldn’t load your account."
          description={message}
        />
        <ActionButton label="Try again" onPress={onRetry} />
        <View style={styles.buttonGap} />
        <ActionButton label="Sign out" variant="secondary" onPress={onSignOut} />
      </View>
    </SafeAreaView>
  );
}

function SessionRecoveryError({
  message,
  onRetry,
  onContinueBrowsing,
}: {
  message: string;
  onRetry: () => void;
  onContinueBrowsing: () => void;
}) {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.loadErrorScreen}>
        <PageHeading
          eyebrow="Connection"
          title="We couldn’t refresh your sign-in."
          description={message}
        />
        <ActionButton label="Try again" onPress={onRetry} />
        <View style={styles.buttonGap} />
        <ActionButton label="Continue browsing" variant="secondary" onPress={onContinueBrowsing} />
      </View>
    </SafeAreaView>
  );
}

function ProfileLoadingSkeleton() {
  return (
    <ScrollView
      style={styles.list}
      contentContainerStyle={styles.profileContent}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading your profile"
    >
      <Skeleton width={218} height={32} />
      <View style={styles.skeletonProfileGap} />
      {[0, 1, 2, 3].map((item) => (
        <View key={item} style={styles.skeletonField}>
          <Skeleton width={96} height={12} />
          <View style={styles.skeletonGap8} />
          <View style={styles.skeletonInput} />
        </View>
      ))}
      <View style={styles.skeletonButton} />
      <View style={styles.skeletonProfileGap} />
      <Skeleton width={112} height={22} />
      <View style={styles.skeletonGap12} />
      <View style={styles.skeletonInput} />
    </ScrollView>
  );
}

function AppContent() {
  const { width } = useWindowDimensions();
  const usesNavigationRail = width >= 700;
  const [token, setToken] = useState<string>();
  const tokenRef = useRef<string | undefined>(undefined);
  tokenRef.current = token;
  const [ready, setReady] = useState(false);
  const [sessionRecoveryMessage, setSessionRecoveryMessage] = useState<string>();
  const sessionRequestId = useRef(0);
  const [tab, setTab] = useState<"feed" | "saved" | "profile">("feed");
  const [preferences, setPreferences] = useState<Preference>();
  const [preferenceError, setPreferenceError] = useState<string>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [catalogError, setCatalogError] = useState<string>();
  const [catalogInitialLoading, setCatalogInitialLoading] = useState(true);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogMoreError, setCatalogMoreError] = useState<string>();
  const [nextCatalogCursor, setNextCatalogCursor] = useState<string>();
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [applications, setApplications] = useState<Application[]>([]);
  const [savingJobIds, setSavingJobIds] = useState<Set<string>>(() => new Set());
  const [hiddenJobIds, setHiddenJobIds] = useState<Set<string>>(() => new Set());
  const [hiddenFeedbackJob, setHiddenFeedbackJob] = useState<Job>();
  const [query, setQuery] = useState("");
  const [guestSearchQuery, setGuestSearchQuery] = useState("");
  const [employerFilter, setEmployerFilter] = useState<EmployerCategory | "all">("all");
  const [jobStatus, setJobStatus] = useState<"open" | "closed">("open");
  const [catalogSource, setCatalogSource] = useState<CatalogSource>("all");
  const [hideUsCitizenshipRequired, setHideUsCitizenshipRequired] = useState(false);
  const [hideAdvancedDegreeRequired, setHideAdvancedDegreeRequired] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [selectedMatchReasons, setSelectedMatchReasons] = useState<FilterMatchReason[]>([]);
  const [selectedExclusionsApplied, setSelectedExclusionsApplied] = useState(false);
  const [jobRouteState, setJobRouteState] = useState<JobRouteState>("idle");
  const routedJobId = useRef<string | undefined>(undefined);
  const detailVisible = useRef(false);
  const detailDismissalPending = useRef(false);
  const pendingDestination = useRef<AppDestination | undefined>(undefined);
  const [launchInbox, setLaunchInbox] = useState<LaunchInbox>();
  const [showLaunchInbox, setShowLaunchInbox] = useState(false);
  const [launchLoaded, setLaunchLoaded] = useState(false);
  const [launchToken, setLaunchToken] = useState<string>();
  const launchRequestToken = useRef<string | undefined>(undefined);
  const launchRequestId = useRef(0);
  const catalogJobsRef = useRef<Job[]>([]);
  const catalogCursorRef = useRef<string | undefined>(undefined);
  const catalogRequestGeneration = useRef(0);
  const catalogRequestInFlight = useRef(false);
  const recoverSession = async (forceRefresh = false) => {
    const requestId = ++sessionRequestId.current;
    const result = await restoreSession({ forceRefresh });
    if (sessionRequestId.current !== requestId) return result;
    if (result.status === "authenticated") {
      tokenRef.current = result.token;
      setToken(result.token);
      setSessionRecoveryMessage(undefined);
    } else if (result.status === "temporarily_unavailable") {
      setSessionRecoveryMessage(result.message);
    } else {
      tokenRef.current = undefined;
      setToken(undefined);
      setSessionRecoveryMessage(undefined);
    }
    return result;
  };
  useEffect(() => {
    void recoverSession().finally(() => setReady(true));
  }, []);
  useEffect(() => {
    const refresh = () => {
      void recoverSession();
    };
    const interval = setInterval(refresh, 45 * 60 * 1_000);
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(interval);
      appStateSubscription.remove();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void responseCache.get<string[]>(hiddenRolesCacheKey).then((cached) => {
      if (active && cached) setHiddenJobIds(new Set(cached));
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    // Show the last successful public catalog immediately. This is especially
    // useful after onboarding, when the launch inbox intentionally has no
    // historical "new" roles to show yet.
    void responseCache.get<CatalogCache>(catalogCacheKey).then((cached) => {
      if (active && cached?.jobs.length && !catalogJobsRef.current.length) {
        catalogJobsRef.current = cached.jobs;
        catalogCursorRef.current = cached.cursor;
        setJobs(cached.jobs);
        setNextCatalogCursor(cached.cursor);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const requestGeneration = ++catalogRequestGeneration.current;
    catalogRequestInFlight.current = true;
    catalogCursorRef.current = undefined;
    setNextCatalogCursor(undefined);
    setCatalogInitialLoading(true);
    setCatalogLoadingMore(false);
    setCatalogError(undefined);
    setCatalogMoreError(undefined);
    const catalogQuery = (token ? query : guestSearchQuery).trim();
    const params = new URLSearchParams({ status: jobStatus, limit: "25" });
    if (catalogQuery) params.set("q", catalogQuery);
    if (catalogSource !== "all") params.set("source", catalogSource);
    void api<CatalogPage<Job>>(`/jobs?${params.toString()}`, "")
      .then((page) => {
        if (catalogRequestGeneration.current !== requestGeneration) return;
        catalogJobsRef.current = page.jobs;
        catalogCursorRef.current = page.cursor;
        setJobs(page.jobs);
        setNextCatalogCursor(page.cursor);
        if (jobStatus === "open" && !catalogQuery && catalogSource === "all") {
          void responseCache.set(catalogCacheKey, page);
        }
      })
      .catch((error) => {
        if (catalogRequestGeneration.current === requestGeneration) {
          setCatalogError(
            error instanceof Error
              ? error.message
              : "We couldn't refresh internships right now.",
          );
        }
      })
      .finally(() => {
        if (catalogRequestGeneration.current === requestGeneration) {
          catalogRequestInFlight.current = false;
          setCatalogInitialLoading(false);
        }
      });
    return () => {
      if (catalogRequestGeneration.current === requestGeneration) {
        catalogRequestGeneration.current += 1;
        catalogRequestInFlight.current = false;
      }
    };
  }, [catalogRefresh, jobStatus, query, guestSearchQuery, catalogSource, token]);
  const loadNextCatalogPage = (retry = false) => {
    const cursor = catalogCursorRef.current;
    if (!cursor || catalogRequestInFlight.current || (!retry && catalogMoreError)) return;
    const requestGeneration = catalogRequestGeneration.current;
    catalogRequestInFlight.current = true;
    setCatalogLoadingMore(true);
    setCatalogMoreError(undefined);
    const catalogQuery = (token ? query : guestSearchQuery).trim();
    const params = new URLSearchParams({ status: jobStatus, limit: "25", cursor });
    if (catalogQuery) params.set("q", catalogQuery);
    if (catalogSource !== "all") params.set("source", catalogSource);
    void api<CatalogPage<Job>>(`/jobs?${params.toString()}`, "")
      .then((page) => {
        if (catalogRequestGeneration.current !== requestGeneration) return;
        const nextJobs = appendCatalogPage(catalogJobsRef.current, page);
        catalogJobsRef.current = nextJobs;
        catalogCursorRef.current = page.cursor;
        setJobs(nextJobs);
        setNextCatalogCursor(page.cursor);
      })
      .catch((error) => {
        if (catalogRequestGeneration.current === requestGeneration) {
          setCatalogMoreError(
            error instanceof Error ? error.message : "We couldn't load more internships right now.",
          );
        }
      })
      .finally(() => {
        if (catalogRequestGeneration.current === requestGeneration) {
          catalogRequestInFlight.current = false;
          setCatalogLoadingMore(false);
        }
      });
  };
  const acceptRefreshedToken = (requestId: number, value: string) => {
    if (sessionRequestId.current !== requestId) return;
    tokenRef.current = value;
    setToken(value);
  };
  const load = async () => {
    if (!tokenRef.current) return;
    setPreferenceError(undefined);
    const requestId = sessionRequestId.current;
    try {
      const [pref, apps] = await Promise.all([
        authenticatedRead<Preference>("/me/preferences", { onToken: (value) => acceptRefreshedToken(requestId, value) }),
        authenticatedRead<{ applications: Application[] }>("/me/applications", { onToken: (value) => acceptRefreshedToken(requestId, value) }),
      ]);
      setPreferences(pref);
      setApplications(apps.applications);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "unauthorized") {
        tokenRef.current = undefined;
        setToken(undefined);
        setPreferenceError(undefined);
        return;
      }
      setPreferenceError(
        error instanceof Error
          ? error.message
          : "Check your connection and try again.",
      );
    }
  };
  useEffect(() => {
    if (token) void load();
  }, [token]);
  useEffect(() => {
    if (token !== launchToken) {
      launchRequestToken.current = undefined;
      setLaunchInbox(undefined);
      setShowLaunchInbox(false);
      setLaunchLoaded(false);
      setLaunchToken(token);
      return;
    }
    if (!token || !preferences?.onboardingComplete || launchLoaded || launchRequestToken.current === token) return;
    launchRequestToken.current = token;
    const requestId = ++launchRequestId.current;
    void api<LaunchInbox>("/me/opening", token, { method: "POST" })
      .then((inbox) => {
        if (launchRequestId.current === requestId) {
          setLaunchInbox(inbox.total ? inbox : undefined);
          setShowLaunchInbox(Boolean(inbox.total));
          if (inbox.jobs.length) {
            setJobs((current) => [
              ...inbox.jobs,
              ...current.filter((job) => !inbox.jobs.some((newJob) => newJob.jobId === job.jobId)),
            ]);
          }
        }
      })
      // The normal feed remains useful if the launch-inbox check is unavailable.
      .catch(() => undefined)
      .finally(() => {
        if (launchRequestId.current === requestId) setLaunchLoaded(true);
      });
  }, [launchLoaded, launchToken, preferences?.onboardingComplete, token]);
  const presentDestination = (destination: AppDestination) => {
    if (destination.kind === "saved") {
      setTab("saved");
      return;
    }
    if (destination.kind === "release") {
      setTab("feed");
      const currentToken = tokenRef.current;
      if (!currentToken) {
        pendingDestination.current = destination;
        return;
      }
      // An explicit notification tap must win over the automatic launch
      // inbox, including when that request already started during cold boot.
      launchRequestId.current += 1;
      launchRequestToken.current = currentToken;
      setLaunchLoaded(true);
      const sessionId = sessionRequestId.current;
      void authenticatedRead<{ jobs: Job[]; total?: number }>(
        `/me/releases/${encodeURIComponent(destination.releaseId)}`,
        { onToken: (value) => acceptRefreshedToken(sessionId, value) },
      )
        .then((release) => {
          const openedAt = new Date().toISOString();
          setLaunchInbox({ jobs: release.jobs, total: release.total ?? release.jobs.length, hasMore: false, previousOpenedAt: null, openedAt });
          setJobs((current) => [...release.jobs, ...current.filter((job) => !release.jobs.some((released) => released.jobId === job.jobId))]);
          setShowLaunchInbox(true);
        })
        .catch((error) => {
          if (error instanceof ApiError && error.kind === "unauthorized") {
            pendingDestination.current = destination;
            tokenRef.current = undefined;
            setToken(undefined);
            return;
          }
          if (error instanceof ApiError && error.kind === "offline") {
            pendingDestination.current = destination;
            setSessionRecoveryMessage(error.message);
            return;
          }
          Alert.alert("Could not open release", error instanceof Error ? error.message : "Please try again.");
        });
      return;
    }
    routedJobId.current = destination.jobId;
    detailVisible.current = true;
    setTab("feed");
    setSelectedJob(null);
    setSelectedMatchReasons(destination.reasons);
    setSelectedExclusionsApplied(destination.exclusionsApplied);
    setJobRouteState("loading");
    void api<Job>(`/jobs/${encodeURIComponent(destination.jobId)}`, "")
      .then((job) => {
        if (routedJobId.current !== destination.jobId) return;
        setSelectedJob(job);
        setJobRouteState("idle");
      })
      .catch((error) => {
        if (routedJobId.current !== destination.jobId) return;
        setJobRouteState(routeFailureState(error));
      });
  };
  const finishDetailDismissal = () => {
    if (!detailDismissalPending.current) return;
    detailDismissalPending.current = false;
    const destination = pendingDestination.current;
    pendingDestination.current = undefined;
    if (destination) presentDestination(destination);
  };
  const dismissRoutedJob = () => {
    const wasVisible = detailVisible.current;
    routedJobId.current = undefined;
    detailVisible.current = false;
    setSelectedJob(null);
    setSelectedMatchReasons([]);
    setSelectedExclusionsApplied(false);
    setJobRouteState("idle");
    if (!wasVisible) return;
    detailDismissalPending.current = true;
    // React Native does not emit Modal.onDismiss on Android. Waiting for
    // interactions still gives the native modal time to release its window
    // before a queued notification presents the next role.
    if (Platform.OS !== "ios") {
      InteractionManager.runAfterInteractions(finishDetailDismissal);
    }
  };
  const openDestination = (destination: AppDestination | undefined, options: { allowActiveJob?: boolean } = {}) => {
    if (!destination) return;
    if (destination.kind === "saved") {
      if (detailVisible.current || detailDismissalPending.current) {
        pendingDestination.current = destination;
        if (detailVisible.current) dismissRoutedJob();
        return;
      }
      presentDestination(destination);
      return;
    }
    if (destination.kind === "release") {
      if (detailVisible.current || detailDismissalPending.current) {
        pendingDestination.current = destination;
        if (detailVisible.current) dismissRoutedJob();
        return;
      }
      presentDestination(destination);
      return;
    }
    const disposition = options.allowActiveJob
      ? "open"
      : jobOpenDisposition(routedJobId.current, destination.jobId, detailDismissalPending.current);
    if (disposition === "ignore") return;
    if (disposition === "replace") {
      pendingDestination.current = destination;
      if (detailVisible.current) dismissRoutedJob();
      return;
    }
    presentDestination(destination);
  };
  useEffect(() => {
    if (!token || detailVisible.current || detailDismissalPending.current || pendingDestination.current?.kind !== "release") return;
    const destination = pendingDestination.current;
    pendingDestination.current = undefined;
    presentDestination(destination);
  }, [token]);
  const openCatalogJob = (job: Job) => {
    if (detailDismissalPending.current) {
      pendingDestination.current = {
        kind: "job",
        jobId: job.jobId,
        reasons: [],
        exclusionsApplied: false,
      };
      return;
    }
    routedJobId.current = job.jobId;
    detailVisible.current = true;
    setSelectedMatchReasons([]);
    setSelectedExclusionsApplied(false);
    setJobRouteState("idle");
    setSelectedJob(job);
  };
  const retryRoutedJob = () => {
    const jobId = routedJobId.current;
    if (!jobId) return;
    openDestination(
      { kind: "job", jobId, reasons: selectedMatchReasons, exclusionsApplied: selectedExclusionsApplied },
      { allowActiveJob: true },
    );
  };
  useEffect(() => {
    const handleNotificationResponse = (response: Notifications.NotificationResponse) => {
      const destination = destinationFromNotification(response.notification.request.content.data);
      openDestination(destination);
      // Expo retains the last response across launches until it is cleared.
      // Once routed (or intentionally ignored), it must not reopen later.
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
    };
    const notificationSubscription = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    const urlSubscription = Linking.addEventListener("url", ({ url }) => openDestination(destinationFromUrl(url)));
    void Promise.allSettled([Notifications.getLastNotificationResponseAsync(), Linking.getInitialURL()]).then(([responseResult, urlResult]) => {
      if (responseResult.status === "fulfilled" && responseResult.value) {
        handleNotificationResponse(responseResult.value);
      }
      if (urlResult.status === "fulfilled" && urlResult.value) {
        openDestination(destinationFromUrl(urlResult.value));
      }
    });
    return () => {
      notificationSubscription.remove();
      urlSubscription.remove();
    };
  }, []);
  const catalogJobs = useMemo(() => {
    const newJobs = jobStatus === "open" ? launchInbox?.jobs ?? [] : [];
    return [
      ...newJobs,
      ...jobs.filter((job) => !newJobs.some((newJob) => newJob.jobId === job.jobId)),
    ];
  }, [jobStatus, jobs, launchInbox]);
  const filtered = useMemo(
    () =>
      catalogJobs
        .filter((job) => !hiddenJobIds.has(job.jobId) || hiddenFeedbackJob?.jobId === job.jobId)
        .filter((job) => employerFilter === "all" || (job.employerCategory ?? "normal") === employerFilter)
        .filter((job) => !hideUsCitizenshipRequired || !job.requirements?.requiresUsCitizenship)
        .filter((job) => !hideAdvancedDegreeRequired || !job.requirements?.advancedDegreeRequired)
        .filter((job) =>
          `${job.company} ${job.title} ${job.location}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    [catalogJobs, employerFilter, hiddenFeedbackJob, hiddenJobIds, hideAdvancedDegreeRequired, hideUsCitizenshipRequired, query],
  );
  const applicationStatuses = useMemo(
    () => new Map(applications.map((application) => [application.jobId, application.status])),
    [applications],
  );
  const roleSections = useMemo<RoleSection[]>(() => {
    const newJobIds = new Set(jobStatus === "open" ? launchInbox?.jobs.map((job) => job.jobId) ?? [] : []);
    if (!newJobIds.size) return [{ kind: "all", data: filtered }];
    const newJobs = filtered.filter((job) => newJobIds.has(job.jobId));
    if (!newJobs.length) return [{ kind: "all", data: filtered }];
    const seenJobs = filtered.filter((job) => !newJobIds.has(job.jobId));
    return [
      { kind: "new", data: newJobs },
      ...(seenJobs.length ? [{ kind: "seen" as const, data: seenJobs }] : []),
    ];
  }, [filtered, jobStatus, launchInbox]);
  const hideLocally = (job: Job) => {
    if (hiddenJobIds.has(job.jobId)) return;
    setHiddenJobIds((current) => {
      const updated = new Set(current).add(job.jobId);
      void responseCache.set(hiddenRolesCacheKey, [...updated]);
      return updated;
    });
    setHiddenFeedbackJob(job);
  };
  const undoHideLocally = () => {
    const job = hiddenFeedbackJob;
    if (!job) return;
    setHiddenJobIds((current) => {
      const updated = new Set(current);
      updated.delete(job.jobId);
      void responseCache.set(hiddenRolesCacheKey, [...updated]);
      return updated;
    });
    setHiddenFeedbackJob(undefined);
  };
  const restoreHiddenRole = (job: Job) => {
    setHiddenJobIds((current) => {
      const updated = new Set(current);
      updated.delete(job.jobId);
      void responseCache.set(hiddenRolesCacheKey, [...updated]);
      return updated;
    });
    if (hiddenFeedbackJob?.jobId === job.jobId) setHiddenFeedbackJob(undefined);
  };
  if (!ready)
    return <AppLoadingSkeleton />;
  if (sessionRecoveryMessage)
    return (
      <SessionRecoveryError
        message={sessionRecoveryMessage}
        onRetry={() => void recoverSession(true)}
        onContinueBrowsing={() => {
          sessionRequestId.current += 1;
          tokenRef.current = undefined;
          setToken(undefined);
          setSessionRecoveryMessage(undefined);
        }}
      />
    );
  if (!token)
    return (
      <GuestExperience
        jobs={jobs}
        routedJob={selectedJob}
        routedMatchReasons={selectedMatchReasons}
        routedExclusionsApplied={selectedExclusionsApplied}
        routeState={jobRouteState}
        onDismissRoute={dismissRoutedJob}
        onModalDismissedRoute={finishDetailDismissal}
        onRetryRoute={retryRoutedJob}
        jobStatus={jobStatus}
        onJobStatusChange={setJobStatus}
        onSearchQueryChange={setGuestSearchQuery}
        sourceFilter={catalogSource}
        onSourceFilterChange={setCatalogSource}
        catalogInitialLoading={catalogInitialLoading}
        catalogError={catalogError}
        catalogLoadingMore={catalogLoadingMore}
        catalogMoreError={catalogMoreError}
        catalogReachedEnd={!nextCatalogCursor && !catalogInitialLoading && !catalogError}
        onLoadMore={() => loadNextCatalogPage()}
        onRetryLoadMore={() => loadNextCatalogPage(true)}
        onRetryCatalog={() => setCatalogRefresh((value) => value + 1)}
        hiddenJobIds={hiddenJobIds}
        hiddenFeedbackJob={hiddenFeedbackJob}
        onHideLocally={hideLocally}
        onUndoHide={undoHideLocally}
        onOpenJob={openCatalogJob}
        onSession={async (idToken) => {
          await sessionStorage.set(idToken);
          sessionRequestId.current += 1;
          tokenRef.current = idToken;
          setToken(idToken);
        }}
      />
    );
  if (!preferences && preferenceError)
    return (
      <AccountLoadError
        message={preferenceError}
        onRetry={() => {
          void recoverSession(true).then((result) => {
            if (result?.status === "authenticated") void load();
          });
        }}
        onSignOut={() => {
          sessionRequestId.current += 1;
          void sessionStorage.clear();
          tokenRef.current = undefined;
          setToken(undefined);
        }}
      />
    );
  if (!preferences)
    return <AppLoadingSkeleton />;
  if (!preferences.onboardingComplete)
    return <Onboarding token={token} onDone={setPreferences} />;
  const apply = (job: Job) => {
    const browser = openOfficialApplication(job.applyUrl);
    void (async () => {
      try {
        const created = await api<Application>("/me/applications", token, {
          method: "POST",
          // Opening an official form adds the role to To Apply. Only a
          // confirmed successful submission may move it to Applied.
          body: JSON.stringify({ jobId: job.jobId }),
        });
        setApplications((current) => [created, ...current.filter((item) => item.applicationId !== created.applicationId)]);
        const alertSettings = preferences.alertSettings ?? defaultAlertSettings;
        if (preferences.alertsEnabled && alertSettings.applicationReminders) {
          void notifyApplicationProgress(
            created.applicationId,
            "Added to To Apply",
            `${job.title} at ${job.company} is ready when you are.`,
          ).catch(() => undefined);
          void scheduleApplicationFollowUp(
            created.applicationId,
            `${job.title} at ${job.company}`,
            alertSettings.followUpDays,
          ).catch(() => undefined);
        }
      } catch {
        // Presenting an alert while iOS is presenting SFSafariViewController
        // can interrupt the browser handoff. Wait until the browser closes.
        await browser;
        Alert.alert(
          "Application tracking unavailable",
          "The official application is open, but we could not save this role to your tracker.",
        );
      }
    })();
  };
  const saveForWeb = (job: Job) => {
    if (applicationStatuses.has(job.jobId) || savingJobIds.has(job.jobId)) return;
    setSavingJobIds((current) => new Set(current).add(job.jobId));
    void (async () => {
      try {
        const created = await api<Application>("/me/applications", token, {
          method: "POST",
          body: JSON.stringify({ jobId: job.jobId, status: "saved" }),
        });
        setApplications((current) => [
          created,
          ...current.filter((item) => item.applicationId !== created.applicationId),
        ]);
        const alertSettings = preferences.alertSettings ?? defaultAlertSettings;
        if (preferences.alertsEnabled && alertSettings.applicationReminders) {
          void scheduleApplicationFollowUp(
            created.applicationId,
            `${job.title} at ${job.company}`,
            alertSettings.followUpDays,
          ).catch(() => undefined);
        }
      } catch (error) {
        Alert.alert(
          "Could not save role",
          error instanceof Error ? error.message : "Please try again.",
        );
      } finally {
        setSavingJobIds((current) => {
          const updated = new Set(current);
          updated.delete(job.jobId);
          return updated;
        });
      }
    })();
  };
  return (
    <SafeAreaView style={styles.screen}>
      <View style={[styles.appShell, usesNavigationRail && styles.appShellWide]}>
        {usesNavigationRail ? <TabNavigation active={tab} onChange={setTab} rail /> : null}
        <View style={styles.appMain}>
          {tab === "feed" ? (
            launchInbox && showLaunchInbox ? (
              <LaunchInbox
                inbox={launchInbox}
                onOpen={openCatalogJob}
                onViewAll={() => setShowLaunchInbox(false)}
                applicationStatuses={applicationStatuses}
                onSaveForWeb={saveForWeb}
                savingJobIds={savingJobIds}
                hiddenJobIds={hiddenJobIds}
                onHideLocally={hideLocally}
                hiddenFeedbackJob={hiddenFeedbackJob}
                onUndoHide={undoHideLocally}
              />
            ) : (
              <>
                <View style={styles.roleFeedControls}>
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    accessibilityLabel="Search roles, companies, and locations"
                    placeholder="Search roles, companies, locations"
                    placeholderTextColor={colors.placeholder}
                    style={styles.feedSearch}
                  />
                  <RoleFilters
                    expanded={filtersExpanded}
                    onToggle={() => setFiltersExpanded((value) => !value)}
                    employerFilter={employerFilter}
                    onEmployerFilterChange={setEmployerFilter}
                    jobStatus={jobStatus}
                    onJobStatusChange={setJobStatus}
                    sourceFilter={catalogSource}
                    onSourceFilterChange={setCatalogSource}
                    hideUsCitizenshipRequired={hideUsCitizenshipRequired}
                    hideAdvancedDegreeRequired={hideAdvancedDegreeRequired}
                    onHideUsCitizenshipRequiredChange={setHideUsCitizenshipRequired}
                    onHideAdvancedDegreeRequiredChange={setHideAdvancedDegreeRequired}
                  />
                </View>
                <SectionList
                  sections={roleSections}
                  keyExtractor={(job) => job.jobId}
                  contentContainerStyle={styles.feedListContent}
                  onEndReached={() => loadNextCatalogPage()}
                  onEndReachedThreshold={0.6}
                  stickySectionHeadersEnabled={false}
                  renderSectionHeader={({ section }) =>
                    section.kind === "new" ? <Text style={styles.newRolesLabel}>New roles</Text>
                      : section.kind === "seen" ? <CaughtUpDivider />
                        : null
                  }
                  ListFooterComponent={
                    <>
                      {roleSections.length === 1 && roleSections[0]?.kind === "new" ? <CaughtUpDivider showSeenLabel={false} /> : null}
                      <CatalogPaginationFooter
                        loading={catalogLoadingMore}
                        error={catalogMoreError}
                        reachedEnd={!nextCatalogCursor && !catalogInitialLoading && !catalogError}
                        searching={Boolean(query.trim())}
                        onRetry={() => loadNextCatalogPage(true)}
                      />
                    </>
                  }
                  renderItem={({ item, index, section }) =>
                    hiddenFeedbackJob?.jobId === item.jobId ? (
                      <HiddenRolePlaceholder onUndo={undoHideLocally} />
                    ) : section.kind === "new" ? (
                      <NewRoleCard
                        job={item}
                        index={index}
                        onOpen={() => openCatalogJob(item)}
                        applicationStatus={applicationStatuses.get(item.jobId)}
                        onSaveForWeb={() => saveForWeb(item)}
                        isSavingForWeb={savingJobIds.has(item.jobId)}
                        onHideLocally={() => hideLocally(item)}
                      />
                    ) : (
                      <JobCard
                        job={item}
                        onOpen={() => openCatalogJob(item)}
                        applicationStatus={applicationStatuses.get(item.jobId)}
                        onSaveForWeb={() => saveForWeb(item)}
                        isSavingForWeb={savingJobIds.has(item.jobId)}
                        onHideLocally={() => hideLocally(item)}
                      />
                    )
                  }
                  ListEmptyComponent={
                    catalogInitialLoading ? <CatalogInitialLoading /> : catalogError ? (
                      <View style={styles.catalogUnavailable}>
                        <EmptyState
                          eyebrow="Catalog unavailable"
                          title="Your latest opportunities will appear here."
                          description="We couldn't refresh the catalog right now. Check your connection and try again."
                        />
                        <ActionButton label="Try again" onPress={() => setCatalogRefresh((value) => value + 1)} />
                      </View>
                    ) : (
                      <EmptyState
                        eyebrow="Search"
                        title="Nothing fits that search yet."
                        description="Try a company, role, or location with fewer terms."
                      />
                    )
                  }
                />
              </>
            )
          ) : tab === "saved" ? (
            <Applications
              applications={applications}
              jobs={catalogJobs}
              token={token}
              alertSettings={preferences.alertSettings ?? defaultAlertSettings}
              alertsEnabled={preferences.alertsEnabled}
              onChanged={() => void load()}
              onOpenOfficialApplication={(applyUrl) => void openOfficialApplication(applyUrl)}
            />
          ) : (
            <Profile
              token={token}
              preferences={preferences}
              hiddenJobs={catalogJobs.filter((job) => hiddenJobIds.has(job.jobId))}
              onRestoreHiddenRole={restoreHiddenRole}
              onPreferencesChanged={(updated) => setPreferences(updated)}
              onSignOut={async () => {
                sessionRequestId.current += 1;
                await sessionStorage.clear();
                tokenRef.current = undefined;
                setToken(undefined);
              }}
            />
          )}
        </View>
        {!usesNavigationRail ? <TabNavigation active={tab} onChange={setTab} /> : null}
      </View>
      <JobDetailSheet
        job={selectedJob}
        signedIn
        matchedReasons={selectedMatchReasons}
        exclusionsApplied={selectedExclusionsApplied}
        routeState={jobRouteState}
        onDismiss={dismissRoutedJob}
        onModalDismissed={finishDetailDismissal}
        onRetry={retryRoutedJob}
        onApply={(job) => {
          if (job.open) void apply(job);
          else void openOfficialApplication(job.applyUrl);
        }}
        onOpenListing={(job) => {
          void openOfficialApplication(job.applyUrl);
        }}
      />
    </SafeAreaView>
  );
}

export default function App() {
  const motionAllowed = useMotionAllowed();
  return (
    <MotionAllowedContext.Provider value={motionAllowed}>
      <AppContent />
    </MotionAllowedContext.Provider>
  );
}

function GuestExperience({
  jobs,
  routedJob,
  routedMatchReasons,
  routedExclusionsApplied,
  routeState,
  onDismissRoute,
  onModalDismissedRoute,
  onRetryRoute,
  jobStatus,
  onJobStatusChange,
  onSearchQueryChange,
  sourceFilter,
  onSourceFilterChange,
  catalogInitialLoading,
  catalogError,
  catalogLoadingMore,
  catalogMoreError,
  catalogReachedEnd,
  onLoadMore,
  onRetryLoadMore,
  onRetryCatalog,
  hiddenJobIds,
  hiddenFeedbackJob,
  onHideLocally,
  onUndoHide,
  onOpenJob,
  onSession,
}: {
  jobs: Job[];
  routedJob: Job | null;
  routedMatchReasons: FilterMatchReason[];
  routedExclusionsApplied: boolean;
  routeState: JobRouteState;
  onDismissRoute: () => void;
  onModalDismissedRoute: () => void;
  onRetryRoute: () => void;
  jobStatus: "open" | "closed";
  onJobStatusChange: (status: "open" | "closed") => void;
  onSearchQueryChange: (query: string) => void;
  sourceFilter: CatalogSource;
  onSourceFilterChange: (source: CatalogSource) => void;
  catalogInitialLoading: boolean;
  catalogError?: string;
  catalogLoadingMore: boolean;
  catalogMoreError?: string;
  catalogReachedEnd: boolean;
  onLoadMore: () => void;
  onRetryLoadMore: () => void;
  onRetryCatalog: () => void;
  hiddenJobIds: Set<string>;
  hiddenFeedbackJob?: Job;
  onHideLocally: (job: Job) => void;
  onUndoHide: () => void;
  onOpenJob: (job: Job) => void;
  onSession: (token: string) => void;
}) {
  const { width } = useWindowDimensions();
  const usesNavigationRail = width >= 700;
  const [tab, setTab] = useState<"feed" | "saved" | "profile">("feed");
  const [query, setQuery] = useState("");
  const [employerFilter, setEmployerFilter] = useState<EmployerCategory | "all">("all");
  const [hideUsCitizenshipRequired, setHideUsCitizenshipRequired] = useState(false);
  const [hideAdvancedDegreeRequired, setHideAdvancedDegreeRequired] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const filtered = useMemo(
    () =>
      jobs
        .filter((job) => !hiddenJobIds.has(job.jobId) || hiddenFeedbackJob?.jobId === job.jobId)
        .filter((job) => employerFilter === "all" || (job.employerCategory ?? "normal") === employerFilter)
        .filter((job) => !hideUsCitizenshipRequired || !job.requirements?.requiresUsCitizenship)
        .filter((job) => !hideAdvancedDegreeRequired || !job.requirements?.advancedDegreeRequired)
        .filter((job) =>
          `${job.company} ${job.title} ${job.location}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    [employerFilter, hiddenFeedbackJob, hiddenJobIds, hideAdvancedDegreeRequired, hideUsCitizenshipRequired, jobs, query],
  );
  if (showAccount)
    return (
      <SignIn onSession={onSession} onBrowse={() => setShowAccount(false)} />
    );
  return (
    <SafeAreaView style={styles.screen}>
      <View style={[styles.appShell, usesNavigationRail && styles.appShellWide]}>
        {usesNavigationRail ? <TabNavigation active={tab} onChange={setTab} rail /> : null}
        <View style={styles.appMain}>
          {tab === "feed" ? (
            <>
              <View style={styles.roleFeedControls}>
                <TextInput
                  value={query}
                  onChangeText={(value) => {
                    setQuery(value);
                    onSearchQueryChange(value);
                  }}
                  accessibilityLabel="Search roles, companies, and locations"
                  placeholder="Search roles, companies, locations"
                  placeholderTextColor={colors.placeholder}
                  style={styles.feedSearch}
                />
                <RoleFilters
                  expanded={filtersExpanded}
                  onToggle={() => setFiltersExpanded((value) => !value)}
                  employerFilter={employerFilter}
                  onEmployerFilterChange={setEmployerFilter}
                  jobStatus={jobStatus}
                  onJobStatusChange={onJobStatusChange}
                  sourceFilter={sourceFilter}
                  onSourceFilterChange={onSourceFilterChange}
                  hideUsCitizenshipRequired={hideUsCitizenshipRequired}
                  hideAdvancedDegreeRequired={hideAdvancedDegreeRequired}
                  onHideUsCitizenshipRequiredChange={setHideUsCitizenshipRequired}
                  onHideAdvancedDegreeRequiredChange={setHideAdvancedDegreeRequired}
                />
              </View>
              <FlatList
                data={filtered}
                keyExtractor={(job) => job.jobId}
                contentContainerStyle={styles.feedListContent}
                onEndReached={onLoadMore}
                onEndReachedThreshold={0.6}
                renderItem={({ item }) =>
                  hiddenFeedbackJob?.jobId === item.jobId ? (
                    <HiddenRolePlaceholder onUndo={onUndoHide} />
                  ) : (
                    <JobCard
                      job={item}
                      onOpen={() => onOpenJob(item)}
                      isNew={isNewJob(item.firstSeenAt, { signedIn: false })}
                      onHideLocally={() => onHideLocally(item)}
                    />
                  )}
                ListEmptyComponent={
                  catalogInitialLoading ? <CatalogInitialLoading /> : catalogError ? (
                    <View style={styles.catalogUnavailable}>
                      <EmptyState
                        eyebrow="Catalog unavailable"
                        title="Your latest opportunities will appear here."
                        description="We couldn't refresh the catalog right now. Check your connection and try again."
                      />
                      <ActionButton label="Try again" onPress={onRetryCatalog} />
                    </View>
                  ) : <EmptyState
                    eyebrow="Search"
                    title="Nothing fits that search yet."
                    description="Try a company, role, or location with fewer terms."
                  />
                }
                ListFooterComponent={
                  <CatalogPaginationFooter
                    loading={catalogLoadingMore}
                    error={catalogMoreError}
                    reachedEnd={catalogReachedEnd}
                    searching={Boolean(query.trim())}
                    onRetry={onRetryLoadMore}
                  />
                }
              />
            </>
          ) : (
            <AccountGate
              feature={
                tab === "saved"
                  ? "save and track applications"
                  : "set up alerts and your application profile"
              }
              onSignIn={() => setShowAccount(true)}
            />
          )}
        </View>
        {!usesNavigationRail ? <TabNavigation active={tab} onChange={setTab} /> : null}
      </View>
      <JobDetailSheet
        job={routedJob}
        signedIn={false}
        matchedReasons={routedJob ? routedMatchReasons : []}
        exclusionsApplied={routedJob ? routedExclusionsApplied : false}
        routeState={routeState}
        onDismiss={onDismissRoute}
        onModalDismissed={onModalDismissedRoute}
        onRetry={onRetryRoute}
        onApply={(job) => {
          void openOfficialApplication(job.applyUrl);
        }}
        onOpenListing={(job) => {
          void openOfficialApplication(job.applyUrl);
        }}
      />
    </SafeAreaView>
  );
}

function AccountGate({
  feature,
  onSignIn,
}: {
  feature: string;
  onSignIn: () => void;
}) {
  return (
    <View style={styles.gate}>
      <Text style={styles.eyebrow}>Account required</Text>
      <Text style={styles.gateTitle}>Save roles you want to pursue.</Text>
      <Text style={styles.intro}>
        Create a free account to {feature}. You can still browse every
        internship without one.
      </Text>
      <Text style={styles.gateBenefit}>What an account keeps</Text>
      <Text style={styles.gateBenefitCopy}>
        Your alert preferences, saved applications, and application profile.
      </Text>
      <View style={styles.gateButton}>
        <ActionButton label="Sign in or create account" onPress={onSignIn} />
      </View>
    </View>
  );
}

function Onboarding({
  token,
  onDone,
}: {
  token: string;
  onDone: (preferences: Preference) => void;
}) {
  const [selected, setSelected] = useState<string[]>(["swe"]);
  const [keywords, setKeywords] = useState("");
  const [alertsRequested, setAlertsRequested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SaveFeedbackState>({ kind: "idle" });
  const toggle = (category: string) =>
    setSelected((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );
  const complete = async () => {
    setSaving(true);
    setFeedback({ kind: "saving", message: "Saving your alert settings…" });
    try {
      const registration = alertsRequested
        ? await registerForJobAlerts(token)
        : undefined;
      const preferences = await api<Preference>("/me/preferences", token, {
        method: "PUT",
        body: JSON.stringify({
          filter: {
            includeCategories: selected,
            includeKeywords: keywords
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          },
          alertsEnabled: registration?.status === "registered",
          alertSettings: defaultAlertSettings,
          onboardingComplete: true,
        }),
      });
      // The saved response is sufficient to leave onboarding. Avoid waiting
      // for another request before showing the main app.
      onDone(preferences);
      if (registration?.status === "denied") showNotificationPermissionHelp();
      if (registration?.status === "unsupported") {
        Alert.alert(
          "Physical device required",
          "Finish setup without alerts here, then enable them from Profile on your iPhone or Android device.",
        );
      }
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Please check your connection and try again.",
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SafeAreaView style={styles.onboardingScreen}>
      <KeyboardAvoidingView
        style={styles.authKeyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.onboardingContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.eyebrow}>Alerts</Text>
          <Text style={styles.hero}>Choose what to watch.</Text>
          <Text style={styles.intro}>
            Pick the roles worth interrupting you for. You can change this at
            any time.
          </Text>
          <Text style={styles.inputLabel}>Role categories</Text>
          <View style={styles.chips}>
            {categories.map((category) => (
              <TouchableOpacity
                key={category}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected.includes(category) }}
                style={[
                  styles.chip,
                  selected.includes(category) && styles.chipOn,
                ]}
                onPress={() => toggle(category)}
              >
                <Text
                  style={[
                    styles.chipLabel,
                    selected.includes(category) && styles.chipLabelOn,
                  ]}
                >
                  {category.toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.inputLabel}>
            Specific keywords <Text style={styles.optionalLabel}>(optional)</Text>
          </Text>
          <TextInput
            style={styles.formInput}
            value={keywords}
            onChangeText={setKeywords}
            accessibilityLabel="Specific keywords"
            placeholder="e.g. backend, robotics, research"
            placeholderTextColor={colors.placeholder}
          />
          <View style={styles.onboardingAlertRow}>
            <View style={styles.preferenceCopy}>
              <Text style={styles.preferenceTitle}>Enable job alerts</Text>
              <Text style={styles.muted}>
                Optional. We only ask for permission after you turn this on.
              </Text>
            </View>
            <Switch
              value={alertsRequested}
              onValueChange={setAlertsRequested}
              accessibilityLabel="Enable job alerts"
              trackColor={{ false: colors.border, true: colors.signal }}
              thumbColor={colors.onDark}
            />
          </View>
          <SaveFeedback state={feedback} onRetry={() => void complete()} />
          <ActionButton
            label={
              saving
                ? "Saving…"
                : alertsRequested
                  ? "Enable alerts and continue"
                  : "Continue without alerts"
            }
            disabled={saving}
            onPress={() => void complete()}
          />
          <Text style={styles.helperText}>
            {alertsRequested
              ? "We’ll ask for notification permission next."
              : "You can turn alerts on later in Profile."}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
function Applications({
  applications,
  jobs,
  token,
  alertSettings,
  alertsEnabled,
  onChanged,
  onOpenOfficialApplication,
}: {
  applications: Application[];
  jobs: Job[];
  token: string;
  alertSettings: AlertSettings;
  alertsEnabled: boolean;
  onChanged: () => void;
  onOpenOfficialApplication: (applyUrl: string) => void;
}) {
  return (
    <FlatList
      style={styles.list}
      data={applications}
      keyExtractor={(item) => item.applicationId}
      contentContainerStyle={styles.feedListContent}
      ListHeaderComponent={
        <PageHeading
          eyebrow="Applications"
          title="Saved applications"
          description="Keep track of the roles you have started or applied to."
        />
      }
      renderItem={({ item }) => {
        const job = resolveApplicationJob(item, jobs);
        const source = sourcePresentation(job?.sourceReferences ?? []);
        const nextStatus = nextApplicationStatuses[item.status] ?? "interview";
        const roleName = job
          ? `${job.title} at ${job.company}`
          : "Saved role";
        return (
          <View style={styles.card}>
            <Text style={styles.company}>{job?.company ?? "Saved role"}</Text>
            <Text style={styles.title}>{job?.title ?? "Role details unavailable"}</Text>
            {job ? <JobSource source={source} /> : null}
            <View style={styles.statusPill}>
              <Text style={styles.statusPillText}>{item.status.toUpperCase()}</Text>
            </View>
            {job?.open ? (
              <View style={styles.applicationActionGap}>
                <ApplyNowButton
                  label="Open official application"
                  hint="Opens the employer's official application in your browser."
                  onPress={() => onOpenOfficialApplication(job.applyUrl)}
                />
              </View>
            ) : null}
            <ActionButton
              label={
                nextStatus === item.status
                  ? "Status up to date"
                  : `Mark as ${nextStatus}`
              }
              compact
              variant="secondary"
              disabled={nextStatus === item.status}
              onPress={() =>
                void (async () => {
                  const updated = await api<Application>(
                    `/me/applications/${item.applicationId}`,
                    token,
                    {
                      method: "PATCH",
                      body: JSON.stringify({ status: nextStatus }),
                    },
                  );
                  onChanged();
                  if (!alertsEnabled || !alertSettings.applicationReminders) return;
                  void notifyApplicationProgress(
                    updated.applicationId,
                    "Application progress updated",
                    `${roleName} is now marked ${updated.status}.`,
                  ).catch(() => undefined);
                  if (["saved", "applied", "assessment", "interview"].includes(updated.status)) {
                    void scheduleApplicationFollowUp(
                      updated.applicationId,
                      roleName,
                      alertSettings.followUpDays,
                    ).catch(() => undefined);
                  } else {
                    void clearApplicationFollowUp(updated.applicationId).catch(() => undefined);
                  }
                })().catch((error) =>
                  Alert.alert(
                    "Could not update application",
                    error instanceof Error ? error.message : "Please try again.",
                  ),
                )
              }
            />
          </View>
        );
      }}
      ListEmptyComponent={
        <EmptyState
          eyebrow="Applications"
          title="Your application list starts here."
          description="Save a role or begin an application to keep its progress in view."
        />
      }
    />
  );
}
function commaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
function aliasesToText(aliases?: Record<string, string>) {
  return Object.entries(aliases ?? {})
    .map(([source, abbreviation]) => `${source} = ${abbreviation}`)
    .join("\n");
}
function aliasesFromText(value: string) {
  const aliases: Record<string, string> = {};
  for (const line of value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = line.indexOf("=");
    if (separator < 1)
      throw new Error(
        "Use one role abbreviation per line: full role = short label",
      );
    const source = line.slice(0, separator).trim();
    const abbreviation = line.slice(separator + 1).trim();
    if (!source || !abbreviation || abbreviation.length > 40)
      throw new Error(
        "Each role abbreviation needs a role and a short label (40 characters or fewer).",
      );
    aliases[source] = abbreviation;
  }
  return aliases;
}

function SettingsHome({
  onOpen,
}: {
  onOpen: (destination: Exclude<SettingsDestination, "home">) => void;
}) {
  return (
    <ScrollView style={styles.list} contentContainerStyle={styles.profileContent}>
      <Text style={[styles.hero, styles.profileHero]}>Settings</Text>
      <Text style={styles.intro}>
        Keep your application details separate from how InternNotifs works for you.
      </Text>
      <View style={styles.settingsList}>
        {settingsDestinations.map((destination) => (
          <TouchableOpacity
            key={destination.id}
            accessibilityRole="button"
            accessibilityLabel={destination.title}
            accessibilityHint={destination.accessibilityHint}
            onPress={() => onOpen(destination.id)}
            style={styles.settingsRow}
          >
            <View style={styles.settingsRowIcon}>
              <Ionicons name={destination.icon} size={22} color={colors.signal} />
            </View>
            <View style={styles.settingsRowCopy}>
              <Text style={styles.settingsRowTitle}>{destination.title}</Text>
              <Text style={styles.settingsRowDescription}>{destination.description}</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={colors.muted} />
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

function Profile({
  token,
  preferences,
  hiddenJobs,
  onRestoreHiddenRole,
  onPreferencesChanged,
  onSignOut,
}: {
  token: string;
  preferences: Preference;
  hiddenJobs: Job[];
  onRestoreHiddenRole: (job: Job) => void;
  onPreferencesChanged: (value: Preference) => void;
  onSignOut: () => void;
}) {
  const [destination, setDestination] = useState<SettingsDestination>("home");
  const [profile, setProfile] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [includeCategories, setIncludeCategories] = useState<string[]>(
    preferences.filter.includeCategories ?? [],
  );
  const [excludeCategories, setExcludeCategories] = useState<string[]>(
    preferences.filter.excludeCategories ?? [],
  );
  const [includeKeywords, setIncludeKeywords] = useState(
    (preferences.filter.includeKeywords ?? []).join(", "),
  );
  const [excludeKeywords, setExcludeKeywords] = useState(
    (preferences.filter.excludeKeywords ?? []).join(", "),
  );
  const [alertsEnabled, setAlertsEnabled] = useState(preferences.alertsEnabled);
  const [notificationsBlocked, setNotificationsBlocked] = useState(false);
  const [includeEmployerCategories, setIncludeEmployerCategories] = useState<EmployerCategory[]>(
    preferences.filter.includeEmployerCategories ?? [],
  );
  const [excludeUsCitizenshipRequired, setExcludeUsCitizenshipRequired] = useState(
    preferences.filter.excludeUsCitizenshipRequired ?? false,
  );
  const [excludeAdvancedDegreeRequired, setExcludeAdvancedDegreeRequired] = useState(
    preferences.filter.excludeAdvancedDegreeRequired ?? false,
  );
  const [delivery, setDelivery] = useState<AlertSettings["delivery"]>(
    preferences.alertSettings?.delivery ?? defaultAlertSettings.delivery,
  );
  const [quietStart, setQuietStart] = useState(
    preferences.alertSettings?.quietHours?.start ?? "22:00",
  );
  const [quietEnd, setQuietEnd] = useState(
    preferences.alertSettings?.quietHours?.end ?? "08:00",
  );
  const [quietTimezone, setQuietTimezone] = useState(
    preferences.alertSettings?.quietHours?.timezone ?? "America/New_York",
  );
  const [applicationReminders, setApplicationReminders] = useState(
    preferences.alertSettings?.applicationReminders ?? true,
  );
  const [followUpDays, setFollowUpDays] = useState(
    String(preferences.alertSettings?.followUpDays ?? defaultAlertSettings.followUpDays),
  );
  const [titleTemplate, setTitleTemplate] = useState(
    preferences.push?.titleTemplate ?? "",
  );
  const [descriptionTemplate, setDescriptionTemplate] = useState(
    preferences.push?.descriptionTemplate ?? "",
  );
  const [roleAliases, setRoleAliases] = useState(
    aliasesToText(preferences.push?.roleAbbreviations),
  );
  const [savingJobPreferences, setSavingJobPreferences] = useState(false);
  const [jobPreferenceFeedback, setJobPreferenceFeedback] = useState<SaveFeedbackState>({
    kind: "idle",
  });
  const [savingAppSettings, setSavingAppSettings] = useState(false);
  const [appSettingsFeedback, setAppSettingsFeedback] = useState<SaveFeedbackState>({
    kind: "idle",
  });
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<SaveFeedbackState>({
    kind: "idle",
  });
  const draftRevisions = useRef<SettingsDraftRevisions>({
    jobPreferences: 0,
    appSettings: 0,
  });
  const syncedDraftRevisions = useRef<SettingsDraftRevisions>({
    jobPreferences: 0,
    appSettings: 0,
  });
  const markJobPreferencesDirty = () => {
    draftRevisions.current.jobPreferences += 1;
  };
  const markAppSettingsDirty = () => {
    draftRevisions.current.appSettings += 1;
  };
  useEffect(() => {
    void authenticatedRead<Record<string, unknown> | null>("/me/profile")
      .then((value) => setProfile(value ?? {}))
      .finally(() => setLoading(false));
  }, [token]);
  useEffect(() => {
    const sync = settingsDraftSyncPlan(
      draftRevisions.current,
      syncedDraftRevisions.current,
    );
    if (sync.jobPreferences) {
      setIncludeCategories(preferences.filter.includeCategories ?? []);
      setExcludeCategories(preferences.filter.excludeCategories ?? []);
      setIncludeKeywords((preferences.filter.includeKeywords ?? []).join(", "));
      setExcludeKeywords((preferences.filter.excludeKeywords ?? []).join(", "));
      setAlertsEnabled(preferences.alertsEnabled);
      setIncludeEmployerCategories(preferences.filter.includeEmployerCategories ?? []);
      setExcludeUsCitizenshipRequired(preferences.filter.excludeUsCitizenshipRequired ?? false);
      setExcludeAdvancedDegreeRequired(preferences.filter.excludeAdvancedDegreeRequired ?? false);
      setDelivery(preferences.alertSettings?.delivery ?? defaultAlertSettings.delivery);
      setQuietStart(preferences.alertSettings?.quietHours?.start ?? "22:00");
      setQuietEnd(preferences.alertSettings?.quietHours?.end ?? "08:00");
      setQuietTimezone(
        preferences.alertSettings?.quietHours?.timezone ?? "America/New_York",
      );
    }
    if (sync.appSettings) {
      setApplicationReminders(
        preferences.alertSettings?.applicationReminders ?? true,
      );
      setFollowUpDays(
        String(preferences.alertSettings?.followUpDays ?? defaultAlertSettings.followUpDays),
      );
      setTitleTemplate(preferences.push?.titleTemplate ?? "");
      setDescriptionTemplate(preferences.push?.descriptionTemplate ?? "");
      setRoleAliases(aliasesToText(preferences.push?.roleAbbreviations));
    }
  }, [preferences]);
  useEffect(() => {
    if (destination === "home") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setDestination("home");
      return true;
    });
    return () => subscription.remove();
  }, [destination]);
  if (destination === "home") return <SettingsHome onOpen={setDestination} />;
  if (loading && destination === "user-info") return <ProfileLoadingSkeleton />;
  const contact = profile.contact as
    | { name?: string; firstName?: string; lastName?: string; email?: string; phone?: string }
    | undefined;
  const updateContact = (next: Partial<NonNullable<typeof contact>>) =>
    setProfile((current) => {
      const currentContact = (current.contact as NonNullable<typeof contact> | undefined) ?? {};
      const updated = { ...currentContact, ...next };
      const fullName = [updated.firstName, updated.lastName]
        .map((value) => value?.trim())
        .filter(Boolean)
        .join(" ");
      return {
        ...current,
        contact: { ...updated, ...(fullName ? { name: fullName } : {}) },
      };
    });
  const toggleCategory = <T extends string,>(
    category: T,
    selected: T[],
    setter: (value: T[]) => void,
  ) =>
    setter(
      selected.includes(category)
        ? selected.filter((item) => item !== category)
        : [...selected, category],
    );
  const uploadResume = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const response = await api<{
      document: { documentId: string };
      uploadUrl: string;
    }>("/me/documents", token, {
      method: "POST",
      body: JSON.stringify({
        fileName: asset.name,
        contentType: asset.mimeType ?? "application/pdf",
      }),
    });
    const file = await fetch(asset.uri);
    await fetch(response.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": asset.mimeType ?? "application/pdf",
        "x-amz-server-side-encryption": "aws:kms",
      },
      body: await file.blob(),
    });
    setProfile((current) => ({
      ...current,
      resumeDocumentId: response.document.documentId,
    }));
    setProfileFeedback({
      kind: "success",
      message: "Résumé uploaded. Save your profile to keep it with your details.",
    });
  };
  const saveProfile = async () => {
    setSavingProfile(true);
    setProfileFeedback({ kind: "saving", message: "Saving your profile…" });
    try {
      await api("/me/profile", token, {
        method: "PUT",
        body: JSON.stringify({
          ...profile,
          links: profile.links ?? {},
          education: profile.education ?? [],
          reusableAnswers: profile.reusableAnswers ?? {},
        }),
      });
      setProfileFeedback({ kind: "success", message: "Profile saved." });
    } catch (error) {
      setProfileFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Your profile could not be saved.",
      });
    } finally {
      setSavingProfile(false);
    }
  };
  const saveJobPreferences = async () => {
    const revisionBeingSaved = draftRevisions.current.jobPreferences;
    setSavingJobPreferences(true);
    setJobPreferenceFeedback({ kind: "saving", message: "Saving job preferences…" });
    try {
      if (alertsEnabled) {
        const registration = await registerForJobAlerts(token);
        if (registration.status !== "registered") {
          setNotificationsBlocked(registration.status === "denied");
          setJobPreferenceFeedback({
            kind: "error",
            message: registration.status === "denied"
              ? "Notifications are off for InternNotifs. Enable them in your device settings, then try again."
              : "Push alerts require a physical iPhone or Android device.",
          });
          return;
        }
      }
      setNotificationsBlocked(false);
      const updated = await api<Preference>("/me/preferences", token, {
        method: "PUT",
        body: JSON.stringify(jobPreferencesPayload({
          filter: {
            includeCategories,
            includeKeywords: commaList(includeKeywords),
            excludeCategories,
            excludeKeywords: commaList(excludeKeywords),
            includeEmployerCategories,
            excludeUsCitizenshipRequired,
            excludeAdvancedDegreeRequired,
          },
          alertsEnabled,
          delivery,
          quietHours: {
            start: quietStart.trim(),
            end: quietEnd.trim(),
            timezone: quietTimezone.trim(),
          },
        })),
      });
      if (draftRevisions.current.jobPreferences === revisionBeingSaved) {
        syncedDraftRevisions.current.jobPreferences = revisionBeingSaved;
      }
      onPreferencesChanged(updated);
      setJobPreferenceFeedback({ kind: "success", message: "Job preferences saved." });
    } catch (error) {
      setJobPreferenceFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Job preferences could not be saved.",
      });
    } finally {
      setSavingJobPreferences(false);
    }
  };
  const saveAppSettings = async () => {
    const revisionBeingSaved = draftRevisions.current.appSettings;
    setSavingAppSettings(true);
    setAppSettingsFeedback({ kind: "saving", message: "Saving app settings…" });
    try {
      const parsedFollowUpDays = Number(followUpDays);
      if (!Number.isInteger(parsedFollowUpDays) || parsedFollowUpDays < 1 || parsedFollowUpDays > 30) {
        throw new Error("Follow-up reminders must be scheduled 1 to 30 days after an update.");
      }
      const aliases = aliasesFromText(roleAliases);
      const push: PushPreferences = {
        ...(titleTemplate.trim()
          ? { titleTemplate: titleTemplate.trim() }
          : {}),
        ...(descriptionTemplate.trim()
          ? { descriptionTemplate: descriptionTemplate.trim() }
          : {}),
        ...(Object.keys(aliases).length ? { roleAbbreviations: aliases } : {}),
      };
      const updated = await api<Preference>("/me/preferences", token, {
        method: "PUT",
        body: JSON.stringify(appSettingsPayload({
          applicationReminders,
          followUpDays: parsedFollowUpDays,
          push,
        })),
      });
      if (draftRevisions.current.appSettings === revisionBeingSaved) {
        syncedDraftRevisions.current.appSettings = revisionBeingSaved;
      }
      onPreferencesChanged(updated);
      setAppSettingsFeedback({ kind: "success", message: "App settings saved." });
    } catch (error) {
      setAppSettingsFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "App settings could not be saved.",
      });
    } finally {
      setSavingAppSettings(false);
    }
  };
  const deleteAccount = () =>
    Alert.alert(
      "Delete account?",
      "This permanently deletes your profile, application tracking, uploaded documents, device alerts, and sign-in account.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () =>
            void api("/me", token, { method: "DELETE" })
              .then(async () => {
                await sessionStorage.clear();
                onSignOut();
              })
              .catch((error) =>
                Alert.alert(
                  "Could not delete account",
                  error instanceof Error ? error.message : "Please try again.",
                ),
              ),
        },
      ],
    );
  const openLink = (label: string, value: string | undefined) => {
    if (!value || !/^https:\/\//.test(value)) {
      Alert.alert(
        `${label} unavailable`,
        "This release is missing its required public link. Please contact support.",
      );
      return;
    }
    void Linking.openURL(value).catch(() =>
      Alert.alert(`Could not open ${label.toLowerCase()}`),
    );
  };
  const previewTemplate = (template: string, fallback: string) =>
    (template.trim() || fallback)
      .replace(/\{shortTitle\}/g, "SWE")
      .replace(/\{title\}/g, "Software Engineering Intern")
      .replace(/\{company\}/g, "Northstar")
      .replace(/\{location\}/g, "New York, NY")
      .replace(/\{season\}/g, "Summer 2027")
      .replace(/\{compensation\}/g, "$52/hr")
      .replace(/\{compensationDetail\}/g, " · $52/hr")
      .replace(/\{focus\}/g, "Focus: Backend/API")
      .replace(/\{posted\}/g, "Today")
      .replace(/\{postedDetail\}/g, " · Employer posted: Today")
      .replace(/\{source\}/g, "Job board")
      .replace(/\{url\}/g, "internnotifs.app/roles/northstar");
  const previewDescription = (template: string, fallback: string) => {
    const selected = template.trim() || fallback;
    return previewTemplate(
      selected.includes("{source}") ? selected : `${selected}\nSource: {source}`,
      fallback,
    );
  };
  return (
    <ScrollView
      style={styles.list}
      contentContainerStyle={styles.profileContent}
      keyboardShouldPersistTaps="handled"
    >
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Back to settings"
        onPress={() => setDestination("home")}
        style={styles.settingsBack}
      >
        <Ionicons name="chevron-back" size={22} color={colors.signal} />
        <Text style={styles.settingsBackText}>Settings</Text>
      </TouchableOpacity>
      {destination === "app-account" ? (
        <>
          <Text style={[styles.hero, styles.profileHero]}>App & account</Text>
          <Text style={styles.intro}>
            Manage notification wording, privacy, and the app data stored on this device.
          </Text>
          {hiddenJobs.length ? (
            <>
              <Text style={styles.profileSectionLabel}>Hidden roles</Text>
              <Text style={styles.muted}>
                These roles are hidden only on this device.
              </Text>
              <View style={styles.hiddenRolesList}>
                {hiddenJobs.map((job) => (
                  <View key={job.jobId} style={styles.hiddenRoleRow}>
                    <View style={styles.hiddenRoleCopy}>
                      <Text style={styles.company}>{job.company}</Text>
                      <Text style={styles.hiddenRoleTitle} numberOfLines={2}>{job.title}</Text>
                    </View>
                    <ActionButton
                      compact
                      label="Restore"
                      onPress={() => onRestoreHiddenRole(job)}
                    />
                  </View>
                ))}
              </View>
              <View style={styles.spacer} />
            </>
          ) : null}
        </>
      ) : null}
      {destination === "user-info" ? (
        <>
      <Text style={[styles.hero, styles.profileHero]}>User info</Text>
      <Text style={styles.intro}>
        Add the details you want available when you apply. You stay in control of every form.
      </Text>
      <Text style={styles.profileSectionLabel}>Contact</Text>
      <Text style={styles.inputLabel}>First name</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="First name"
        placeholder="First name"
        placeholderTextColor={colors.placeholder}
        value={contact?.firstName ?? ""}
        onChangeText={(firstName) => updateContact({ firstName })}
      />
      <Text style={styles.inputLabel}>Last name</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Last name"
        placeholder="Last name"
        placeholderTextColor={colors.placeholder}
        value={contact?.lastName ?? ""}
        onChangeText={(lastName) => updateContact({ lastName })}
      />
      <Text style={styles.inputLabel}>Email</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Email"
        placeholder="you@example.com"
        placeholderTextColor={colors.placeholder}
        value={contact?.email ?? ""}
        onChangeText={(email) => updateContact({ email })}
      />
      <Text style={styles.inputLabel}>Phone</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Phone"
        placeholder="Phone number"
        placeholderTextColor={colors.placeholder}
        keyboardType="phone-pad"
        value={contact?.phone ?? ""}
        onChangeText={(phone) => updateContact({ phone })}
      />
      <Text style={styles.inputLabel}>Location</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Location"
        placeholder="Location"
        placeholderTextColor={colors.placeholder}
        value={(profile.location as string) ?? ""}
        onChangeText={(location) => setProfile({ ...profile, location })}
      />
      <Text style={styles.inputLabel}>Work authorization</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Work authorization"
        placeholder="Work authorization"
        placeholderTextColor={colors.placeholder}
        value={(profile.workAuthorization as string) ?? ""}
        onChangeText={(workAuthorization) =>
          setProfile({ ...profile, workAuthorization })
        }
      />
      <ActionButton
        label={profile.resumeDocumentId ? "Replace résumé" : "Upload résumé"}
        variant="secondary"
        onPress={() => void uploadResume()}
      />
      <View style={styles.spacer} />
      <ActionButton
        label={savingProfile ? "Saving profile…" : "Save profile"}
        disabled={savingProfile}
        onPress={() => void saveProfile()}
      />
      <SaveFeedback state={profileFeedback} onRetry={() => void saveProfile()} />
      <View style={styles.spacer} />
        </>
      ) : null}
      {destination === "job-preferences" ? (
        <>
      <Text style={[styles.hero, styles.profileHero]}>Job preferences</Text>
      <Text style={styles.intro}>
        Choose the roles you want to see and when you want to hear about them.
      </Text>
      <Text style={styles.profileSectionLabel}>Alerts and filters</Text>
      <Text style={styles.sectionTitle}>Job alerts</Text>
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>Job alerts</Text>
          <Text style={styles.muted}>
            Turn delivery on or off for this device.
          </Text>
        </View>
        <Switch
          value={alertsEnabled}
          onValueChange={(value) => {
            markJobPreferencesDirty();
            setAlertsEnabled(value);
          }}
          accessibilityLabel="Job alerts"
          trackColor={{ false: colors.border, true: colors.signal }}
          thumbColor={colors.onDark}
        />
      </View>
      <Text style={styles.preferenceTitle}>Company type</Text>
      <Text style={styles.muted}>
        Limit alerts to the kinds of companies you want to follow. Leave all three off for every company.
      </Text>
      <View style={styles.chips}>
        {(["faang", "startup", "normal"] as EmployerCategory[]).map((category) => (
          <TouchableOpacity
            key={`employer-${category}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: includeEmployerCategories.includes(category) }}
            style={[styles.chip, includeEmployerCategories.includes(category) && styles.chipOn]}
            onPress={() => {
              markJobPreferencesDirty();
              toggleCategory(category, includeEmployerCategories, setIncludeEmployerCategories);
            }}
          >
            <Text style={[styles.chipLabel, includeEmployerCategories.includes(category) && styles.chipLabelOn]}>
              {employerCategoryLabels[category]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.preferenceTitle}>Requirements to avoid</Text>
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>U.S. citizenship required</Text>
          <Text style={styles.muted}>Hide roles whose source explicitly requires U.S. citizenship.</Text>
        </View>
        <Switch
          value={excludeUsCitizenshipRequired}
          onValueChange={(value) => {
            markJobPreferencesDirty();
            setExcludeUsCitizenshipRequired(value);
          }}
          accessibilityLabel="Hide roles requiring U.S. citizenship"
          trackColor={{ false: colors.border, true: colors.signal }}
          thumbColor={colors.onDark}
        />
      </View>
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>Advanced degree required</Text>
          <Text style={styles.muted}>Hide roles marked for a master’s, PhD, or MBA.</Text>
        </View>
        <Switch
          value={excludeAdvancedDegreeRequired}
          onValueChange={(value) => {
            markJobPreferencesDirty();
            setExcludeAdvancedDegreeRequired(value);
          }}
          accessibilityLabel="Hide roles requiring an advanced degree"
          trackColor={{ false: colors.border, true: colors.signal }}
          thumbColor={colors.onDark}
        />
      </View>
      <Text style={styles.preferenceTitle}>Delivery timing</Text>
      <View style={styles.choiceGroup} accessibilityRole="radiogroup">
        <ChoiceOption
          label="Immediate"
          description="Receive matching roles as they are found."
          selected={delivery === "immediate"}
          onPress={() => {
            markJobPreferencesDirty();
            setDelivery("immediate");
          }}
        />
        <ChoiceOption
          label="Daily digest"
          description="Review matching roles together once a day."
          selected={delivery === "daily-digest"}
          onPress={() => {
            markJobPreferencesDirty();
            setDelivery("daily-digest");
          }}
        />
      </View>
      <Text style={styles.preferenceTitle}>Quiet hours</Text>
      <Text style={styles.muted}>
        We’ll hold alerts during this window and deliver them afterward.
      </Text>
      <View style={styles.timeRow}>
        <View style={styles.timeField}>
          <Text style={styles.inputLabel}>Start</Text>
          <TextInput
            style={styles.search}
            accessibilityLabel="Quiet hours start"
            value={quietStart}
            onChangeText={(value) => {
              markJobPreferencesDirty();
              setQuietStart(value);
            }}
            placeholder="22:00"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
          />
        </View>
        <View style={styles.timeField}>
          <Text style={styles.inputLabel}>End</Text>
          <TextInput
            style={styles.search}
            accessibilityLabel="Quiet hours end"
            value={quietEnd}
            onChangeText={(value) => {
              markJobPreferencesDirty();
              setQuietEnd(value);
            }}
            placeholder="08:00"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
          />
        </View>
      </View>
      <Text style={styles.inputLabel}>Timezone</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Quiet hours timezone"
        value={quietTimezone}
        onChangeText={(value) => {
          markJobPreferencesDirty();
          setQuietTimezone(value);
        }}
        placeholder="America/New_York"
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
      />
      <Text style={styles.preferenceTitle}>Include role categories</Text>
      <View style={styles.chips}>
        {categories.map((category) => (
          <TouchableOpacity
            key={`include-${category}`}
            style={[
              styles.chip,
              includeCategories.includes(category) && styles.chipOn,
            ]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: includeCategories.includes(category) }}
            onPress={() => {
              markJobPreferencesDirty();
              toggleCategory(category, includeCategories, setIncludeCategories);
            }}
          >
            <Text
              style={[
                styles.chipLabel,
                includeCategories.includes(category) && styles.chipLabelOn,
              ]}
            >
              {category.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.inputLabel}>Include keywords</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Include keywords"
        value={includeKeywords}
        onChangeText={(value) => {
          markJobPreferencesDirty();
          setIncludeKeywords(value);
        }}
        placeholder="Include keywords, comma separated"
        placeholderTextColor={colors.placeholder}
      />
      <Text style={styles.preferenceTitle}>Exclude role categories</Text>
      <View style={styles.chips}>
        {categories.map((category) => (
          <TouchableOpacity
            key={`exclude-${category}`}
            style={[
              styles.chip,
              excludeCategories.includes(category) && styles.chipExclude,
            ]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: excludeCategories.includes(category) }}
            onPress={() => {
              markJobPreferencesDirty();
              toggleCategory(category, excludeCategories, setExcludeCategories);
            }}
          >
            <Text
              style={[
                styles.chipLabel,
                excludeCategories.includes(category) && styles.chipLabelExclude,
              ]}
            >
              {category.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.inputLabel}>Exclude keywords</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Exclude keywords"
        value={excludeKeywords}
        onChangeText={(value) => {
          markJobPreferencesDirty();
          setExcludeKeywords(value);
        }}
        placeholder="Exclude keywords, comma separated"
        placeholderTextColor={colors.placeholder}
      />
      <ActionButton
        label={savingJobPreferences ? "Saving…" : "Save job preferences"}
        disabled={savingJobPreferences}
        onPress={() => void saveJobPreferences()}
      />
      <SaveFeedback
        state={jobPreferenceFeedback}
        onRetry={() => void saveJobPreferences()}
      />
      {notificationsBlocked ? (
        <>
          <View style={styles.buttonGap} />
          <ActionButton label="Open notification settings" variant="secondary" onPress={openAppSettings} />
        </>
      ) : null}
      <View style={styles.spacer} />
        </>
      ) : null}
      {destination === "app-account" ? (
        <>
      <Text style={styles.profileSectionLabel}>Notifications</Text>
      <Text style={styles.preferenceTitle}>Notification wording</Text>
      <Text style={styles.muted}>
        Supported placeholders: {pushPlaceholders.join(", ")}.
      </Text>
      <Text style={styles.inputLabel}>Notification title</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Notification title"
        placeholder="Title: {shortTitle} — {company}"
        placeholderTextColor={colors.placeholder}
        value={titleTemplate}
        onChangeText={(value) => {
          markAppSettingsDirty();
          setTitleTemplate(value);
        }}
      />
      <Text style={styles.inputLabel}>Notification description</Text>
      <TextInput
        style={[styles.search, styles.multiline]}
        accessibilityLabel="Notification description"
        placeholder="Description: {location} · {season}\nSource: {source}\n{url}"
        placeholderTextColor={colors.placeholder}
        value={descriptionTemplate}
        onChangeText={(value) => {
          markAppSettingsDirty();
          setDescriptionTemplate(value);
        }}
        multiline
      />
      <Text style={styles.inputLabel}>Role abbreviations</Text>
      <TextInput
        style={[styles.search, styles.multiline]}
        accessibilityLabel="Role abbreviations"
        placeholder="Role abbreviations, one per line: software engineer = SWE"
        placeholderTextColor={colors.placeholder}
        value={roleAliases}
        onChangeText={(value) => {
          markAppSettingsDirty();
          setRoleAliases(value);
        }}
        multiline
        autoCapitalize="none"
      />
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>Application reminders</Text>
          <Text style={styles.muted}>
            Confirm changes you make here and remind you to follow up. External
            employer portals do not update InternNotifs automatically.
          </Text>
        </View>
        <Switch
          value={applicationReminders}
          onValueChange={(value) => {
            markAppSettingsDirty();
            setApplicationReminders(value);
          }}
          accessibilityLabel="Application reminders"
          trackColor={{ false: colors.border, true: colors.signal }}
          thumbColor={colors.onDark}
        />
      </View>
      <Text style={styles.inputLabel}>Follow up after (days)</Text>
      <TextInput
        style={styles.search}
        accessibilityLabel="Follow up after days"
        value={followUpDays}
        onChangeText={(value) => {
          markAppSettingsDirty();
          setFollowUpDays(value);
        }}
        keyboardType="number-pad"
        placeholder="7"
        placeholderTextColor={colors.placeholder}
      />
      <Text style={styles.preferenceTitle}>Live notification preview</Text>
      <View style={styles.notificationPreview}>
        <Text style={styles.notificationPreviewApp}>INTERNNOTIFS</Text>
        <Text style={styles.notificationPreviewTitle}>
          {previewTemplate(titleTemplate, "{shortTitle} — {company}")}
        </Text>
        <Text style={styles.notificationPreviewBody}>
          {previewDescription(
            descriptionTemplate,
            "{location} · {season}{compensationDetail}\n{focus}{postedDetail}\nSource: {source}\n{url}",
          )}
        </Text>
      </View>
      <ActionButton
        label={savingAppSettings ? "Saving…" : "Save app settings"}
        disabled={savingAppSettings}
        onPress={() => void saveAppSettings()}
      />
      <SaveFeedback
        state={appSettingsFeedback}
        onRetry={() => void saveAppSettings()}
      />
      <View style={styles.spacer} />
      <Text style={styles.profileSectionLabel}>Account</Text>
      <Text style={styles.sectionTitle}>Account and support</Text>
      <ActionButton
        label="Privacy policy"
        variant="secondary"
        onPress={() =>
          openLink("Privacy policy", process.env.EXPO_PUBLIC_PRIVACY_URL)
        }
      />
      <View style={styles.buttonGap} />
      <ActionButton
        label="Support"
        variant="secondary"
        onPress={() => openLink("Support", process.env.EXPO_PUBLIC_SUPPORT_URL)}
      />
      <View style={styles.spacer} />
      <ActionButton label="Sign out" variant="secondary" onPress={onSignOut} />
      <View style={styles.spacer} />
      <ActionButton label="Delete account" variant="danger" onPress={deleteAccount} />
        </>
      ) : null}
    </ScrollView>
  );
}

function AuthButton({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.authButton,
        secondary && styles.authButtonSecondary,
        disabled && styles.authButtonDisabled,
      ]}
    >
      <Text
        style={[
          styles.authButtonText,
          secondary && styles.authButtonTextSecondary,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function SignIn({
  onSession,
  onBrowse,
}: {
  onSession: (token: string) => void;
  onBrowse?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      Alert.alert(
        "Account",
        error instanceof Error ? error.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const title = needsConfirmation
    ? "Check your email"
    : createMode
      ? "Create your account"
      : "Sign in";
  const description = needsConfirmation
    ? "Enter the verification code we sent to your email."
    : createMode
      ? "Use an email and password to save roles and receive alerts."
      : "Sign in to pick up where you left off.";
  return (
    <SafeAreaView style={styles.authScreen}>
      <KeyboardAvoidingView
        style={styles.authKeyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.authContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.authBrand}>
            <Text style={styles.eyebrow}>InternNotifs</Text>
            <Text style={styles.authName}>Save your search.</Text>
            <Text style={styles.authTagline}>
              Track roles and set alerts when you need them.
            </Text>
          </View>
          <View style={styles.authCard}>
            <Text style={styles.authTitle}>{title}</Text>
            <Text style={styles.authDescription}>{description}</Text>
            <Text style={styles.inputLabel}>Email</Text>
            <TextInput
              autoCapitalize="none"
              autoComplete="email"
              accessibilityLabel="Email"
              keyboardType="email-address"
              returnKeyType={needsConfirmation ? "next" : "next"}
              style={styles.authInput}
              placeholder="you@example.com"
              placeholderTextColor={colors.placeholder}
              value={email}
              onChangeText={setEmail}
            />
            {needsConfirmation ? (
              <>
                <Text style={styles.inputLabel}>Verification code</Text>
                <TextInput
                  autoComplete="one-time-code"
                  accessibilityLabel="Verification code"
                  keyboardType="number-pad"
                  returnKeyType="done"
                  style={styles.authInput}
                  placeholder="6-digit code"
                  placeholderTextColor={colors.placeholder}
                  value={code}
                  onChangeText={setCode}
                />
                <AuthButton
                  label={busy ? "Verifying…" : "Verify email"}
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await confirmEmail(email, code);
                      setNeedsConfirmation(false);
                      setCreateMode(false);
                      Alert.alert(
                        "Verified",
                        "Your account is ready. Sign in to continue.",
                      );
                    })
                  }
                />
              </>
            ) : (
              <>
                <Text style={styles.inputLabel}>Password</Text>
                <TextInput
                  autoComplete={
                    createMode ? "new-password" : "current-password"
                  }
                  accessibilityLabel="Password"
                  secureTextEntry
                  returnKeyType="done"
                  style={styles.authInput}
                  placeholder={
                    createMode ? "At least 12 characters" : "Your password"
                  }
                  placeholderTextColor={colors.placeholder}
                  value={password}
                  onChangeText={setPassword}
                  onSubmitEditing={() => {
                    if (!busy)
                      void run(async () =>
                        createMode
                          ? (await signUp(email, password),
                            setNeedsConfirmation(true))
                          : onSession(await signIn(email, password)),
                      );
                  }}
                />
                <AuthButton
                  label={
                    busy
                      ? createMode
                        ? "Creating…"
                        : "Signing in…"
                      : createMode
                        ? "Create account"
                        : "Sign in"
                  }
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      if (createMode) {
                        await signUp(email, password);
                        setNeedsConfirmation(true);
                      } else {
                        onSession(await signIn(email, password));
                      }
                    })
                  }
                />
                <AuthButton
                  secondary
                  label={
                    createMode
                      ? "I already have an account"
                      : "Create an account"
                  }
                  disabled={busy}
                  onPress={() => setCreateMode((current) => !current)}
                />
              </>
            )}
          </View>
          {onBrowse ? (
            <AuthButton
              secondary
              label="Continue browsing"
              onPress={onBrowse}
            />
          ) : null}
          <Text style={styles.authFootnote}>
            Your account keeps your saved roles, alerts, and application profile.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  appShell: { flex: 1 },
  appShellWide: { flexDirection: "row" },
  appMain: { flex: 1, minWidth: 0 },
  skeleton: { backgroundColor: colors.separator },
  skeletonNav: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  skeletonPage: {
    alignSelf: "center",
    flex: 1,
    maxWidth: 760,
    paddingHorizontal: 20,
    paddingTop: 20,
    width: "100%",
  },
  loadingTitleGroup: { marginBottom: 20 },
  skeletonSearch: {
    height: 52,
    backgroundColor: colors.separator,
    borderRadius: 12,
    marginBottom: 24,
  },
  skeletonSection: { marginBottom: 16 },
  skeletonGap8: { height: 8 },
  skeletonGap12: { height: 12 },
  skeletonProfileGap: { height: 24 },
  skeletonField: { marginBottom: 12 },
  skeletonInput: {
    height: 52,
    backgroundColor: colors.separator,
    borderRadius: 12,
  },
  skeletonButton: {
    height: 52,
    backgroundColor: colors.border,
    borderRadius: 12,
    marginTop: 8,
  },
  skeletonNavRail: {
    alignSelf: "stretch",
    borderRightColor: colors.separator,
    borderRightWidth: 1,
    borderTopWidth: 0,
    flexDirection: "column",
    height: undefined,
    justifyContent: "flex-start",
    paddingHorizontal: 24,
    paddingVertical: 28,
    width: 96,
  },
  loadErrorScreen: {
    flex: 1,
    justifyContent: "flex-start",
    paddingHorizontal: 20,
    paddingTop: 32,
  },
  nav: {
    flexDirection: "row",
    height: 64,
    paddingHorizontal: 20,
    alignItems: "center",
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  navItem: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 52 },
  navRail: {
    alignSelf: "stretch",
    borderRightColor: colors.separator,
    borderRightWidth: 1,
    borderTopWidth: 0,
    flexDirection: "column",
    height: undefined,
    justifyContent: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 16,
    width: 96,
  },
  navRailItem: { flex: 0, marginBottom: 8, width: "100%" },
  navLabel: { color: colors.muted, fontSize: 12, fontWeight: "600", marginTop: 3 },
  navLabelActive: { color: colors.ink, fontWeight: "700" },
  inboxHeader: { paddingTop: 28, paddingBottom: 20 },
  inboxCount: {
    color: colors.ink,
    fontSize: 76,
    fontWeight: "800",
    letterSpacing: -3,
    lineHeight: 82,
  },
  inboxTitle: { color: colors.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.7, lineHeight: 36 },
  inboxDescription: { color: colors.muted, fontSize: 16, lineHeight: 22, marginTop: 6 },
  inboxOverflow: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 },
  inboxViewAll: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: colors.signal,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 14,
    marginTop: 16,
  },
  inboxViewAllText: { color: colors.signal, fontSize: 15, fontWeight: "700" },
  inboxViewAllFooter: { alignSelf: "center", marginBottom: 12, marginTop: 24 },
  inboxSectionLabel: { color: colors.signal, fontSize: 12, fontWeight: "700", letterSpacing: 1, marginTop: 28 },
  newRolesLabel: { color: colors.signal, fontSize: 12, fontWeight: "700", letterSpacing: 1, marginTop: 8, marginBottom: 12 },
  caughtUpBlock: { marginTop: 20, marginBottom: 12 },
  caughtUpRuleRow: { alignItems: "center", flexDirection: "row", gap: 10 },
  caughtUpLine: { backgroundColor: colors.separator, flex: 1, height: 1 },
  caughtUpText: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  seenRolesLabel: { color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 1, marginTop: 14 },
  list: { flex: 1 },
  feedListContent: {
    alignSelf: "center",
    maxWidth: 760,
    paddingHorizontal: 20,
    paddingBottom: 28,
    width: "100%",
  },
  catalogInitialLoading: { paddingTop: 12 },
  catalogPagination: { alignItems: "center", minHeight: 52, justifyContent: "center", paddingVertical: 12 },
  catalogPaginationText: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: "center" },
  catalogPaginationRetry: { alignItems: "center", justifyContent: "center", minHeight: 44, paddingHorizontal: 12 },
  catalogPaginationRetryText: { color: colors.signal, fontSize: 14, fontWeight: "700" },
  profileContent: {
    alignSelf: "center",
    maxWidth: 760,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 44,
    width: "100%",
  },
  settingsList: { borderTopColor: colors.separator, borderTopWidth: 1 },
  settingsRow: {
    alignItems: "center",
    borderBottomColor: colors.separator,
    borderBottomWidth: 1,
    flexDirection: "row",
    minHeight: 88,
    paddingVertical: 14,
  },
  settingsRowIcon: {
    alignItems: "center",
    backgroundColor: colors.signalSoft,
    borderRadius: 10,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  settingsRowCopy: { flex: 1, paddingHorizontal: 14 },
  settingsRowTitle: { color: colors.ink, fontSize: 17, fontWeight: "700", lineHeight: 22 },
  settingsRowDescription: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 2 },
  settingsBack: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    marginBottom: 16,
    marginLeft: -6,
    minHeight: 44,
    paddingRight: 10,
  },
  settingsBackText: { color: colors.signal, fontSize: 16, fontWeight: "700" },
  pageHeading: { marginBottom: 0 },
  card: {
    backgroundColor: colors.surface,
    padding: 16,
    marginBottom: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  swipeCard: { marginBottom: 12, position: "relative" },
  swipeCardSurface: { marginBottom: 0 },
  swipeSaveAction: {
    alignItems: "center",
    backgroundColor: colors.signal,
    borderRadius: 14,
    bottom: 0,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingLeft: 16,
    position: "absolute",
    right: 0,
    top: 0,
    width: 112,
  },
  swipeSaveActionText: { color: colors.onDark, fontSize: 14, fontWeight: "800" },
  swipeHideAction: {
    alignItems: "center",
    backgroundColor: colors.body,
    borderRadius: 14,
    bottom: 0,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingRight: 16,
    position: "absolute",
    left: 0,
    top: 0,
    width: 112,
  },
  swipeHideActionText: { color: colors.onDark, fontSize: 14, fontWeight: "800" },
  newRoleGlow: {
    backgroundColor: colors.signalGlow,
    borderRadius: 14,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  sheetDismissArea: { flex: 1 },
  jobSheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 32,
    maxHeight: "92%",
  },
  sheetContent: { paddingBottom: 4 },
  sheetHandle: {
    alignSelf: "center",
    backgroundColor: colors.border,
    borderRadius: 2,
    height: 4,
    marginBottom: 24,
    width: 40,
  },
  sheetEyebrow: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  sheetTitle: {
    color: colors.ink,
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: 32,
  },
  sheetCompany: {
    color: colors.body,
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 24,
    marginTop: 8,
  },
  sheetDetail: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 4,
  },
  sheetTrustBlock: { gap: 3, marginTop: 16 },
  sheetTrustPrimary: { color: colors.body, fontSize: 14, fontWeight: "700", lineHeight: 20 },
  sheetTrustSecondary: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  sheetMatchBlock: {
    backgroundColor: colors.signalSoft,
    borderRadius: 12,
    marginTop: 18,
    padding: 14,
  },
  sheetMatchTitle: { color: colors.ink, fontSize: 14, fontWeight: "700", lineHeight: 20 },
  sheetMatchText: { color: colors.body, fontSize: 14, lineHeight: 20, marginTop: 3 },
  sheetMatchHelper: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  sheetClosedNotice: {
    backgroundColor: colors.dangerSoft,
    borderColor: colors.dangerBorder,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 20,
    padding: 12,
  },
  sheetClosedText: { color: colors.danger, fontSize: 14, fontWeight: "600", lineHeight: 20 },
  sheetActions: { gap: 12, marginTop: 28 },
  applyNowButton: {
    alignItems: "center",
    backgroundColor: colors.ink,
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 16,
    position: "relative",
  },
  applyNowTitle: { color: colors.onDark, fontSize: 17, fontWeight: "700", lineHeight: 22, textAlign: "center" },
  applyNowArrow: { position: "absolute", right: 16 },
  sheetHelper: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
    textAlign: "center",
  },
  catalogUnavailable: { gap: 16 },
  company: {
    color: colors.signal,
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "700",
  },
  jobCompanyRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  newSpark: {
    alignItems: "center",
    backgroundColor: colors.signalSoft,
    borderRadius: 999,
    flexDirection: "row",
    gap: 4,
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  newSparkText: { color: colors.signal, fontSize: 11, fontWeight: "800", letterSpacing: 0.2 },
  title: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: "700",
    lineHeight: 24,
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.ink,
    letterSpacing: -0.3,
  },
  muted: { color: colors.muted, marginTop: 4, lineHeight: 21 },
  postingTiming: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 2 },
  jobSourceRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 7 },
  jobSourceText: { color: colors.muted, flexShrink: 1, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  jobSourceCorroboration: { color: colors.signal, fontSize: 12, fontWeight: "700", lineHeight: 18 },
  pay: { marginTop: 8, color: colors.signal, fontSize: 14, fontWeight: "600" },
  closedStatus: { marginTop: 8, color: colors.danger, fontWeight: "700" },
  jobCardAction: { alignItems: "center", flexDirection: "row", marginTop: 14 },
  jobCardActionText: { color: colors.signal, fontSize: 15, fontWeight: "700" },
  jobCardActionArrow: { color: colors.signal, fontSize: 22, lineHeight: 20, marginLeft: 5 },
  jobApplicationStatus: {
    alignSelf: "flex-start",
    backgroundColor: colors.signalSoft,
    borderRadius: 999,
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  jobApplicationStatusText: { color: colors.signal, fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  search: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  feedSearch: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
    marginTop: 12,
    marginBottom: 0,
  },
  roleFeedControls: {
    alignSelf: "center",
    maxWidth: 760,
    paddingHorizontal: 20,
    width: "100%",
  },
  filterRegion: { marginTop: 12, marginBottom: 12 },
  filterBar: { flexDirection: "row", alignItems: "center", minHeight: 48 },
  filterToggle: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: 2,
  },
  filterToggleText: { color: colors.signal, fontSize: 15, fontWeight: "700" },
  filterToggleGlyph: { color: colors.signal, fontSize: 20, fontWeight: "400", marginLeft: 8 },
  clearFilters: { minHeight: 48, justifyContent: "center", marginLeft: 16 },
  clearFiltersText: { color: colors.muted, fontSize: 15, fontWeight: "600" },
  filterPanel: {
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    marginTop: 4,
    paddingTop: 16,
  },
  coverageRegion: {
    borderTopColor: colors.separator,
    borderTopWidth: 1,
    marginTop: 4,
  },
  coverageToggle: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 58,
    paddingVertical: 8,
  },
  coverageToggleTitle: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  coverageToggleSummary: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 2 },
  coveragePanel: { paddingBottom: 12 },
  coverageStats: {
    flexDirection: "row",
    gap: 28,
    marginBottom: 12,
    marginTop: 4,
  },
  coverageStatValue: { color: colors.ink, fontSize: 21, fontWeight: "800" },
  coverageStatLabel: { color: colors.muted, fontSize: 12, marginTop: 2 },
  coverageExplanation: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  coverageSearch: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 15,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  coverageResults: { marginTop: 8 },
  coverageRow: {
    alignItems: "center",
    borderBottomColor: colors.separator,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 56,
    paddingVertical: 8,
  },
  coverageCompanyCopy: { flex: 1, paddingRight: 16 },
  coverageCompany: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  coverageCompanyState: { color: colors.muted, fontSize: 12, marginTop: 3, textTransform: "capitalize" },
  coverageRoleCount: { color: colors.body, fontSize: 13, fontWeight: "600" },
  coverageAsOf: { color: colors.muted, fontSize: 12, marginTop: 12 },
  filterLabel: { color: colors.body, fontSize: 13, fontWeight: "700", marginBottom: 8 },
  companyFilter: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  formInput: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
    marginBottom: 20,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  emptyState: {
    alignItems: "flex-start",
    paddingTop: 32,
    paddingBottom: 24,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 21,
    fontWeight: "700",
    letterSpacing: -0.25,
  },
  emptyCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 6 },
  onboardingScreen: { flex: 1, backgroundColor: colors.canvas },
  onboardingContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 42,
    paddingBottom: 36,
  },
  eyebrow: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  pageTitle: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.6,
    lineHeight: 34,
  },
  hero: { fontSize: 30, fontWeight: "800", color: colors.ink, letterSpacing: -0.6, lineHeight: 36 },
  profileHero: { marginBottom: 0 },
  pageDescription: { color: colors.muted, fontSize: 16, lineHeight: 22, marginTop: 6, marginBottom: 16 },
  intro: { color: colors.muted, fontSize: 16, lineHeight: 23, marginTop: 10, marginBottom: 28 },
  chips: { flexDirection: "row", flexWrap: "wrap", marginTop: 8, marginBottom: 24, gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 48,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.signalSoft, borderColor: colors.signal },
  chipExclude: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  chipLabel: { color: colors.body, fontSize: 14, fontWeight: "700" },
  chipLabelOn: { color: colors.signal },
  chipLabelExclude: { color: colors.danger },
  optionalLabel: { color: colors.muted, fontWeight: "400" },
  helperText: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 14 },
  preferenceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    marginTop: 12,
    paddingVertical: 16,
  },
  preferenceCopy: { flex: 1, paddingRight: 16 },
  onboardingAlertRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    paddingTop: 16,
    marginBottom: 20,
  },
  preferenceTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 12,
  },
  choiceGroup: { marginTop: 12, marginBottom: 16, gap: 8 },
  choiceOption: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.separator,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  choiceOptionSelected: { backgroundColor: colors.signalSoft, borderColor: colors.signal },
  choiceCopy: { flex: 1, paddingRight: 12 },
  choiceLabel: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  choiceLabelSelected: { color: colors.signal },
  choiceDescription: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 3 },
  choiceMark: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  choiceMarkSelected: { borderColor: colors.signal },
  choiceMarkDot: { backgroundColor: colors.signal, borderRadius: 5, height: 10, width: 10 },
  timeRow: { flexDirection: "row", gap: 12 },
  timeField: { flex: 1 },
  notificationPreview: {
    backgroundColor: colors.ink,
    borderRadius: 14,
    marginTop: 10,
    marginBottom: 16,
    padding: 16,
  },
  notificationPreviewApp: {
    color: "#A5F3FC",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
  },
  notificationPreviewTitle: { color: colors.onDark, fontSize: 16, fontWeight: "700", marginTop: 6 },
  notificationPreviewBody: { color: "#D1D1D6", fontSize: 14, lineHeight: 20, marginTop: 4 },
  saveFeedback: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  saveFeedbackSuccess: { backgroundColor: colors.successSoft, borderColor: colors.successBorder },
  saveFeedbackError: { backgroundColor: colors.dangerSoft, borderColor: colors.dangerBorder },
  saveFeedbackText: { color: colors.body, fontSize: 14, lineHeight: 20 },
  saveFeedbackRetry: { color: colors.signal, fontSize: 14, fontWeight: "700", marginTop: 8 },
  hiddenRolePlaceholder: {
    alignItems: "center",
    backgroundColor: colors.signalSoft,
    borderColor: colors.separator,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    justifyContent: "center",
    marginBottom: 12,
    minHeight: 88,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  hiddenRolePlaceholderText: { color: colors.body, fontSize: 14, fontWeight: "600" },
  hiddenRolePlaceholderUndo: { color: colors.signal, fontSize: 14, fontWeight: "800" },
  profileSectionLabel: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  statusPill: {
    alignSelf: "flex-start",
    backgroundColor: colors.signalSoft,
    borderRadius: 999,
    marginTop: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusPillText: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  hiddenRolesList: { marginTop: 12, gap: 8 },
  hiddenRoleRow: {
    alignItems: "center",
    borderTopColor: colors.separator,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingTop: 12,
  },
  hiddenRoleCopy: { flex: 1 },
  hiddenRoleTitle: { color: colors.ink, fontSize: 15, fontWeight: "700", lineHeight: 20, marginTop: 2 },
  applicationActionGap: { marginTop: 14 },
  buttonGap: { height: 12 },
  spacer: { height: 24 },
  gate: { flex: 1, justifyContent: "flex-start", paddingHorizontal: 20, paddingTop: 32 },
  gateTitle: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.7,
  },
  gateBenefit: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  gateBenefitCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 6 },
  gateButton: { alignSelf: "stretch", marginTop: 24 },
  authScreen: { flex: 1, backgroundColor: colors.canvas },
  authKeyboard: { flex: 1 },
  authContent: {
    flexGrow: 1,
    justifyContent: "flex-start",
    paddingHorizontal: 20,
    paddingTop: 32,
    paddingBottom: 32,
  },
  authBrand: { alignItems: "flex-start", marginBottom: 28 },
  authName: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  authTagline: { color: colors.muted, fontSize: 16, lineHeight: 23, marginTop: 8 },
  authCard: { padding: 0 },
  authTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  authDescription: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
    marginBottom: 22,
  },
  inputLabel: {
    color: colors.body,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 7,
  },
  authInput: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
    marginBottom: 16,
    backgroundColor: colors.surface,
  },
  authButton: {
    minHeight: 52,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.ink,
    marginTop: 4,
  },
  authButtonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 12,
  },
  authButtonDisabled: { opacity: 0.55 },
  authButtonText: { color: colors.onDark, fontSize: 16, fontWeight: "700" },
  authButtonTextSecondary: { color: colors.body },
  authFootnote: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    textAlign: "left",
    marginTop: 20,
  },
  actionButton: {
    minHeight: 52,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.ink,
  },
  actionButtonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionButtonDanger: { backgroundColor: colors.danger },
  actionButtonCompact: { minHeight: 48, marginTop: 16 },
  actionButtonDisabled: { opacity: 0.55 },
  actionButtonText: { color: colors.onDark, fontSize: 16, fontWeight: "700" },
  actionButtonTextSecondary: { color: colors.body },
});
