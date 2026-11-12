<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { useRouter } from 'vue-router'
import { NewLabelOutlined, EmailOutlined, RedeemOutlined } from '@vicons/material'

// ИМПОРТ ФОНА
import bgImage from '@/assets/bg.png' 

import AdminContact from '../common/AdminContact.vue'
import Turnstile from '../../components/Turnstile.vue'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { getRouterPathWithLang, hashPassword } from '../../utils'

const props = defineProps({
    bindUserAddress: {
        type: Function,
        default: async () => { await api.bindUserAddress(); },
        required: true
    },
    newAddressPath: {
        type: Function,
        default: async (address_name, domain, cf_token, enableRandomSubdomain) => {
            return await api.fetch("/api/new_address", {
                method: "POST",
                body: JSON.stringify({
                    name: address_name,
                    domain: domain,
                    cf_token: cf_token,
                    enableRandomSubdomain: enableRandomSubdomain,
                }),
            });
        },
        required: true
    },
})

const message = useMessage()
const notification = useNotification()
const router = useRouter()

const {
    jwt, loading, openSettings,
    showAddressCredential, userSettings, addressPassword
} = useGlobalState()

const tabValue = ref('signin')
const credential = ref('')
const emailName = ref("")
const emailDomain = ref("")
const cfToken = ref("")
const subdomainMode = ref("normal")
const customSubdomain = ref("")
const loginCfToken = ref("")
const loginTurnstileRef = ref(null)
const loginMethod = ref('credential')
const loginAddress = ref('')
const loginPassword = ref('')

const initLoginMethod = () => {
    if (openSettings.value?.enableAddressPassword) {
        loginMethod.value = 'password';
    } else {
        loginMethod.value = 'credential';
    }
}

const login = async () => {
    if (loginMethod.value === 'password') {
        if (!loginAddress.value || !loginPassword.value) {
            message.error(t('emailPasswordRequired'));
            return;
        }
        try {
            const res = await api.fetch('/api/address_login', {
                method: 'POST',
                body: JSON.stringify({
                    email: loginAddress.value,
                    password: await hashPassword(loginPassword.value),
                    cf_token: loginCfToken.value
                })
            });
            jwt.value = res.jwt;
            await api.getSettings();
            try { await props.bindUserAddress(); } catch (error) { message.error(`${t('bindUserAddressError')}: ${error.message}`); }
            await router.push(getRouterPathWithLang("/", locale.value));
        } catch (error) {
            message.error(error.message || "error");
            loginTurnstileRef.value?.refresh?.();
        }
        return;
    }
    if (!credential.value) {
        message.error(t('credentialInput'));
        return;
    }
    try {
        await api.fetch('/open_api/credential_login', {
            method: 'POST',
            body: JSON.stringify({ credential: credential.value, cf_token: loginCfToken.value })
        });
        jwt.value = credential.value;
        await api.getSettings();
        try { await props.bindUserAddress(); } catch (error) { message.error(`${t('bindUserAddressError')}: ${error.message}`); }
        await router.push(getRouterPathWithLang("/", locale.value));
    } catch (error) {
        message.error(error.message || "error");
        loginTurnstileRef.value?.refresh?.();
    }
}

const { locale, t } = useScopedI18n('views.common.Login')

const loginAndBindTag = computed(() => userSettings.value.user_email ? t('loginAndBind') : t('login'))

const addressRegex = computed(() => {
    try {
        if (openSettings.value.addressRegex) return new RegExp(openSettings.value.addressRegex, 'g');
    } catch (error) {
        console.error(error);
        message.error(`Invalid addressRegex: ${openSettings.value.addressRegex}`);
    }
    return /[^a-z0-9]/g;
});

const generateNameLoading = ref(false);
const generateName = async () => {
    try {
        generateNameLoading.value = true;
        const { faker } = await import('https://esm.sh/@faker-js/faker');
        emailName.value = faker.internet.email().split('@')[0].replace(/\s+/g, '.').replace(/\.{2,}/g, '.').replace(addressRegex.value, '').toLowerCase();
        if (emailName.value.length > openSettings.value.maxAddressLen) {
            emailName.value = emailName.value.slice(0, openSettings.value.maxAddressLen);
        }
    } catch (error) { message.error(error.message || "error"); } finally { generateNameLoading.value = false; }
};

const newEmail = async () => {
    try {
        const nameToSend = openSettings.value.disableCustomAddressName ? "" : emailName.value;
        const domainToSend = subdomainMode.value === "custom" ? `${customSubdomain.value.trim()}.${emailDomain.value}` : emailDomain.value;
        const res = await props.newAddressPath(nameToSend, domainToSend, cfToken.value, subdomainMode.value === "random");
        jwt.value = res["jwt"];
        addressPassword.value = res["password"] || '';
        await api.getSettings();
        await router.push(getRouterPathWithLang("/", locale.value));
        showAddressCredential.value = true;
        try { await props.bindUserAddress(); } catch (error) { message.error(`${t('bindUserAddressError')}: ${error.message}`); }
    } catch (error) { message.error(error.message || "error"); }
};

const openRedeemPage = async () => { await router.push(getRouterPathWithLang('/redeem', locale.value)); };

const addressPrefix = computed(() => userSettings.value?.user_role ? userSettings.value.user_role.prefix || "" : openSettings.value.prefix);

const canUseRandomSubdomain = computed(() => {
    if (!emailDomain.value) return false;
    return (openSettings.value.randomSubdomainDomains || []).includes(emailDomain.value);
});

watch(canUseRandomSubdomain, (enabled) => { if (!enabled) subdomainMode.value = "normal"; });

const domainsOptions = computed(() => {
    if (userSettings.value.user_role) {
        const allDomains = userSettings.value.user_role.domains;
        if (!allDomains) return openSettings.value.domains;
        return openSettings.value.domains.filter((domain) => allDomains.includes(domain.value));
    }
    if (!openSettings.value.defaultDomains) return openSettings.value.domains;
    return openSettings.value.domains.filter((domain) => openSettings.value.defaultDomains.includes(domain.value));
});

const showNewAddressTab = computed(() => {
    if (openSettings.value.disableAnonymousUserCreateEmail && !userSettings.value.user_email) return false;
    return openSettings.value.enableUserCreateEmail;
});

onMounted(async () => {
    if (!openSettings.value.domains || openSettings.value.domains.length === 0) {
        await api.getOpenSettings(message, notification);
    }
    emailDomain.value = domainsOptions.value ? domainsOptions.value[0]?.value : "";
    initLoginMethod();
});
</script>

<template>
    <div class="login-layout">
        
        <!-- Размытый фон (Ambient) для заполнения пустых краев -->
        <div class="ambient-bg" :style="{ backgroundImage: `url(${bgImage})` }"></div>
        
        <!-- Светящиеся сферы -->
        <div class="glow-sphere sphere-1"></div>
        <div class="glow-sphere sphere-2"></div>

        <!-- Четкая картинка с C.C. (теперь по центру, без искажений) -->
        <img :src="bgImage" class="bg-image" alt="Background" />

        <!-- Киберпанк-сетка (теперь ПОВЕРХ картинки, чтобы ее было видно) -->
        <div class="cyber-grid"></div>

        <!-- Декоративные HUD-линии по краям -->
        <div class="hud-line left-hud"></div>
        <div class="hud-line right-hud"></div>

        <!-- Контент поверх фона -->
        <div class="content-wrapper">
            <!-- Баннер -->
            <div class="welcome-banner">
                <div class="lines top-lines"></div>
                <h1 class="welcome-text">
                    <span class="welcome-w">W</span>
                    <span class="welcome-el">EL</span>
                    <span class="welcome-c">C</span>
                    <span class="welcome-o">O</span>
                    <span class="welcome-me">ME</span>
                </h1>
                <div class="swoosh"></div>
                <div class="lines bottom-lines"></div>
                <p class="welcome-subtext">GACHA SUKI MAIL</p>
            </div>

            <!-- Форма входа -->
            <div class="login-form-wrapper">
                <n-alert v-if="userSettings.user_email" :show-icon="false" :bordered="false" closable>
                    <span>{{ t('bindUserInfo') }}</span>
                </n-alert>
                
                <n-tabs v-if="openSettings.fetched" v-model:value="tabValue" size="large" justify-content="space-evenly">
                    <n-tab-pane name="signin" :tab="loginAndBindTag">
                        <n-form>
                            <div v-if="loginMethod === 'password'">
                                <n-form-item-row :label="t('email')" required>
                                    <n-input v-model:value="loginAddress" />
                                </n-form-item-row>
                                <n-form-item-row :label="t('password')" required>
                                    <n-input v-model:value="loginPassword" type="password" show-password-on="click"
                                        @keyup.enter="login" />
                                </n-form-item-row>
                            </div>
                            <div v-else>
                                <n-form-item-row :label="t('credential')" required>
                                    <n-input v-model:value="credential" type="textarea" :autosize="{ minRows: 3 }" />
                                </n-form-item-row>
                            </div>

                            <Turnstile ref="loginTurnstileRef" v-if="openSettings.enableGlobalTurnstileCheck" v-model:value="loginCfToken" />

                            <div class="switch-login-button">
                                <n-button v-if="openSettings?.enableAddressPassword && !openSettings.addressPasswordLoginOnly"
                                    @click="loginMethod === 'password' ? loginMethod = 'credential' : loginMethod = 'password'"
                                    type="info" quaternary size="tiny">
                                    {{ loginMethod === 'password' ? t('credentialLogin') : t('passwordLogin') }}
                                </n-button>
                            </div>

                            <n-button @click="login" :loading="loading" type="primary" block secondary strong>
                                <template #icon><n-icon :component="EmailOutlined" /></template>
                                {{ loginAndBindTag }}
                            </n-button>
                            <n-button v-if="showNewAddressTab" @click="tabValue = 'register'" block secondary strong>
                                <template #icon><n-icon :component="NewLabelOutlined" /></template>
                                {{ t('getNewEmail') }}
                            </n-button>
                            <div v-if="openSettings.enableRedeemCode" class="redeem-entry-section">
                                <n-divider />
                                <n-text type="info" class="redeem-entry-tip">{{ t('redeemEntryTip') }}</n-text>
                                <n-button data-testid="redeem-entry" block secondary strong @click="openRedeemPage">
                                    <template #icon><n-icon :component="RedeemOutlined" /></template>
                                    {{ t('useRedeemCode') }}
                                </n-button>
                            </div>
                        </n-form>
                    </n-tab-pane>
                    
                    <n-tab-pane v-if="showNewAddressTab" name="register" :tab="t('getNewEmail')">
                        <n-spin :show="generateNameLoading">
                            <n-form>
                                <span>
                                    <p v-if="!openSettings.disableCustomAddressName">{{ t("getNewEmailTip1") + addressRegex.source }}</p>
                                    <p v-if="!openSettings.disableCustomAddressName">{{ t("getNewEmailTip2") }}</p>
                                    <p>{{ t("getNewEmailTip3") }}</p>
                                </span>
                                <n-button v-if="!openSettings.disableCustomAddressName" @click="generateName" style="margin-bottom: 10px;">
                                    {{ t('generateName') }}
                                </n-button>
                                <n-input-group>
                                    <n-input-group-label v-if="addressPrefix">{{ addressPrefix }}</n-input-group-label>
                                    <n-input v-if="!openSettings.disableCustomAddressName" v-model:value="emailName" show-count :minlength="openSettings.minAddressLen" :maxlength="openSettings.maxAddressLen" />
                                    <n-input v-else :value="t('autoGeneratedName')" disabled />
                                    <n-input-group-label>@</n-input-group-label>
                                    <n-select v-model:value="emailDomain" :consistent-menu-width="false" :options="domainsOptions" />
                                </n-input-group>
                                <n-form-item-row v-if="canUseRandomSubdomain">
                                    <div style="width: 100%;">
                                        <n-radio-group v-model:value="subdomainMode">
                                            <n-space vertical>
                                                <n-radio value="normal">{{ t('normalSubdomain') }}</n-radio>
                                                <n-radio value="random">{{ t('enableRandomSubdomain') }}</n-radio>
                                                <n-radio value="custom">{{ t('enableCustomSubdomain') }}</n-radio>
                                            </n-space>
                                        </n-radio-group>
                                        <p v-if="subdomainMode === 'random'" style="margin: 8px 0 0; opacity: 0.75;">{{ t('randomSubdomainTip') }}</p>
                                        <n-input-group v-if="subdomainMode === 'custom'" style="margin-top: 8px;">
                                            <n-input v-model:value="customSubdomain" />
                                            <n-input-group-label>.{{ emailDomain }}</n-input-group-label>
                                        </n-input-group>
                                    </div>
                                </n-form-item-row>
                                <Turnstile v-model:value="cfToken" />
                                <n-button type="primary" block secondary strong @click="newEmail" :loading="loading" :disabled="subdomainMode === 'custom' && !customSubdomain.trim()">
                                    <template #icon><n-icon :component="NewLabelOutlined" /></template>
                                    {{ t('getNewEmail') }}
                                </n-button>
                                <div v-if="openSettings.enableRedeemCode" class="redeem-entry-section">
                                    <n-divider />
                                    <n-text type="info" class="redeem-entry-tip">{{ t('redeemEntryTip') }}</n-text>
                                    <n-button data-testid="redeem-entry-register" block secondary strong @click="openRedeemPage">
                                        <template #icon><n-icon :component="RedeemOutlined" /></template>
                                        {{ t('useRedeemCode') }}
                                    </n-button>
                                </div>
                            </n-form>
                        </n-spin>
                    </n-tab-pane>
                    <n-tab-pane name="help" :tab="t('help')">
                        <n-alert :show-icon="false" :bordered="false">
                            <span>{{ t('pleaseGetNewEmail') }}</span>
                        </n-alert>
                        <AdminContact />
                    </n-tab-pane>
                </n-tabs>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* --- Контейнер --- */
.login-layout {
    position: relative;
    width: 100%;
    min-height: 80vh;
    display: flex;
    justify-content: center;
    align-items: center;
}

/* =========================================
   ФОНОВЫЕ СЛОИ (ВСЕ FIXED, ЧТОБЫ ЗАПОЛНИТЬ ЭКРАН)
   ========================================= */

/* 1. Самый нижний слой: размытая копия для краев */
.ambient-bg {
    position: fixed; 
    top: -10%; left: -10%; right: -10%; bottom: -10%; 
    background-size: cover;
    background-position: center;
    filter: blur(60px) brightness(0.25); 
    z-index: -3; 
}

/* 2. Сферы свечения */
.glow-sphere {
    position: fixed;
    border-radius: 50%;
    filter: blur(80px);
    z-index: -2;
    opacity: 0.3;
}
.sphere-1 {
    width: 400px; height: 400px;
    background: rgba(0, 255, 136, 0.4);
    top: 10%; left: 10%;
}
.sphere-2 {
    width: 500px; height: 500px;
    background: rgba(255, 105, 180, 0.15);
    bottom: 5%; right: 10%;
}

/* 3. ОСНОВНАЯ КАРТИНКА (Четкая, с сохранением пропорций) */
.bg-image {
    position: fixed; 
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    
    /* Используем contain, чтобы картинка не искажалась */
    width: 100vw; 
    height: 100vh;
    object-fit: contain; 
    
    z-index: -1;
    /* Никакой прозрачности и размытия */
}

/* 4. КИБЕРПАНК СЕТКА (ПОВЕРХ КАРТИНКИ) */
.cyber-grid {
    position: fixed; 
    top: 0; left: 0; right: 0; bottom: 0;
    background-image: 
        linear-gradient(rgba(0, 255, 136, 0.07) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 255, 136, 0.07) 1px, transparent 1px);
    background-size: 40px 40px;
    z-index: 1; /* Ставим выше картинки, чтобы сетка ложилась поверх C.C. */
    pointer-events: none; /* Клики проходят сквозь сетку */
}

/* 5. Боковые линии HUD */
.hud-line {
    position: fixed;
    top: 20%;
    bottom: 20%;
    width: 2px;
    background: linear-gradient(to bottom, transparent, #00ff88, transparent);
    z-index: 2;
    opacity: 0.4;
    box-shadow: 0 0 10px #00ff88;
    pointer-events: none;
}
.left-hud { left: 5vw; }
.right-hud { right: 5vw; }

/* =========================================
   КОНТЕНТ И ФОРМА
   ========================================= */

.content-wrapper {
    position: relative;
    z-index: 10; /* Форма всегда выше всех фонов */
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 20px;
}

/* --- БАННЕР --- */
.welcome-banner {
    position: relative;
    text-align: center;
    margin-bottom: 20px; 
    display: flex;
    flex-direction: column;
    align-items: center;
}

.welcome-text {
    font-family: 'Playfair Display', 'Times New Roman', serif;
    font-size: 3.5rem; 
    font-weight: 900;
    margin: 0;
    color: #ffffff;
    letter-spacing: -2px; 
    line-height: 1;
    text-shadow: 0 0 15px rgba(0, 255, 136, 0.5); 
}

.lines {
    width: 180px; 
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.8), transparent);
    position: relative;
    margin: 8px 0;
}
.top-lines::before, .top-lines::after,
.bottom-lines::before, .bottom-lines::after {
    content: '';
    position: absolute;
    width: 30px;
    height: 1px;
    background: rgba(255, 255, 255, 0.5);
    top: 50%;
}
.top-lines::before, .bottom-lines::before { right: 100%; margin-right: 10px; }
.top-lines::after, .bottom-lines::after { left: 100%; margin-left: 10px; }

.swoosh {
    position: absolute;
    top: 40%;
    left: 20%;
    width: 60%;
    height: 30px;
    border-top: 2px solid #ff69b4; 
    border-radius: 50%;
    transform: rotate(-5deg);
    pointer-events: none;
    opacity: 0.6;
}

.welcome-subtext {
    color: #a0a0a0;
    font-family: sans-serif;
    letter-spacing: 4px;
    text-transform: uppercase;
    font-size: 0.7rem;
    margin-top: 8px;
}

/* --- ФОРМА ВХОДА --- */
.login-form-wrapper {
    width: 340px; 
    flex-shrink: 0; 
    background-color: rgba(15, 15, 20, 0.85); 
    backdrop-filter: blur(15px); 
    padding: 25px 20px; 
    border-radius: 16px;
    box-shadow: 
        0 10px 40px rgba(0, 0, 0, 0.9), 
        inset 0 0 0 1px rgba(144, 238, 144, 0.3); 
    z-index: 10;
}

/* --- Мобильная версия --- */
@media (max-width: 850px) {
    .login-form-wrapper { width: 90%; max-width: 340px; }
    .welcome-text { font-size: 2.5rem; letter-spacing: -1px; }
    .swoosh { display: none; }
    .lines { width: 120px; }
    .hud-line { display: none; }
}

/* --- Твои изначальные стили --- */
.n-alert { margin-top: 10px; margin-bottom: 10px; text-align: center; }
.n-form .n-button { margin-top: 10px; }
.redeem-entry-section { margin-top: 15px; }
.redeem-entry-section :deep(.n-divider) { margin: 0 0 12px; }
.redeem-entry-tip { display: block; font-size: 12px; line-height: 1.5; text-align: center; }
.switch-login-button { display: flex; justify-content: center; margin: 8px 0; }
.n-form { text-align: left; }
</style>
