#!/usr/bin/env python3
"""Add password-rollback / change-password-notification keys to both catalogs."""
import json
import collections

PATHS = {
    'zh-CN': 'public/i18n/locales/zh-CN.json',
    'en': 'public/i18n/locales/en.json',
}

# zh-CN value == key (source language); en value = translation.
EN = {
    '密码已修改': 'Password Changed',
    '恢复链接': 'Recovery link',
    '复制链接': 'Copy link',
    '我知道了': 'Got it',
    '链接已复制': 'Link copied',
    '复制失败，请手动复制': 'Copy failed — please copy it manually',
    '恢复密码': 'Restore password',
    '正在恢复…': 'Restoring…',
    '恢复失败，请稍后再试': 'Recovery failed — please try again later',
    '有效期至：{time}': 'Valid until: {time}',
    '恢复之前的密码': 'Restore Previous Password',
    '恢复之前的密码 · Zephyr': 'Restore Previous Password · Zephyr',
    '我们已向您的邮箱发送了通知邮件，其中包含一个恢复链接（24 小时内有效，仅可使用一次）。如果本次修改不是您本人操作，请通过邮件中的链接恢复之前的密码。':
        'A notification email with a recovery link (valid for 24 hours, single use) has been sent to your mailbox. If you did not make this change, use the link in the email to restore your previous password.',
    '当前账号未绑定邮箱，无法发送通知邮件。请立即妥善保存以下恢复链接：如果本次修改不是您本人操作，可在 24 小时内通过该链接恢复之前的密码。链接仅可使用一次，关闭本窗口后将无法再次查看。':
        'This account has no bound mailbox, so no notification email could be sent. Save the recovery link below now: if you did not make this change, you can restore the previous password within 24 hours via this link. It is single-use and cannot be shown again after this window is closed.',
    '当前账号已开启 TOTP 并绑定邮箱：修改密码需要当前密码 + TOTP 动态码 + 邮箱验证码。':
        'TOTP is enabled and a mailbox is bound: changing the password requires your current password + TOTP code + email code.',
    '当前账号已开启 TOTP：修改密码需要当前密码 + TOTP 动态码。':
        'TOTP is enabled: changing the password requires your current password + TOTP code.',
    '当前账号已绑定邮箱：修改密码需要当前密码 + 邮箱验证码。':
        'A mailbox is bound: changing the password requires your current password + email code.',
    '当前账号未开启 TOTP 且未绑定邮箱：仅验证当前密码。建议开启 TOTP 或绑定邮箱以提升安全性。':
        'TOTP is off and no mailbox is bound: only your current password is verified. Enable TOTP or bind a mailbox for better security.',
    '此链接用于在密码被非本人修改后，将账号恢复到修改前的密码。':
        'This link restores your account to its previous password after a change you did not make.',
    '仅当本次密码修改不是您本人操作时，才应点击恢复。':
        'Only restore if you did NOT make this password change.',
    '恢复后所有设备上的会话都会退出，请使用之前的密码重新登录。':
        'Restoring signs out every session on all devices — sign back in with your previous password.',
    '恢复链接无效、已使用或已过期。如需要，请重新修改密码。':
        'This recovery link is invalid, already used, or expired. Change your password again if needed.',
    '密码已恢复：所有会话已退出，请使用之前的密码重新登录。':
        'Password restored: all sessions have been signed out. Sign in with your previous password.',
}

for loc, path in PATHS.items():
    with open(path, encoding='utf-8') as f:
        data = json.load(f, object_pairs_hook=collections.OrderedDict)
    added = 0
    for key, en_val in EN.items():
        if key in data:
            continue
        data[key] = key if loc == 'zh-CN' else en_val
        added += 1
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(loc, 'added', added, '→ total', len(data))
