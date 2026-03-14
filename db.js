import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

// We expect the user to provide their Firebase Service Account JSON
// Either via a file path in ENV or as a base64 encoded string
let serviceAccount;

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        serviceAccount = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('ascii'));
    } else {
        // For local dev without a formal service account if available, or throw
        console.warn("No Firebase Service account provided. Database calls will fail unless running in a default GCP environment.");
    }
} catch (error) {
    console.error("Failed to parse Firebase Service Account:", error);
}

// Initialize Firebase Admin
try {
    initializeApp({
        credential: serviceAccount ? cert(serviceAccount) : undefined
    });
    console.log('Firebase Admin initialized successfully');
} catch (error) {
    console.error('Firebase initialization error:', error);
}

export const db = getFirestore();

// Helper functions for our specific data models

export async function saveAuthToken(telegramUserId, tokenData) {
    try {
        const userRef = db.collection('users').doc(telegramUserId.toString());
        await userRef.set({
            swiggyAuth: {
                token: tokenData,
                updatedAt: new Date().toISOString()
            }
        }, { merge: true });
        return true;
    } catch (error) {
        console.error('Error saving auth token:', error);
        return false;
    }
}

export async function getAuthToken(telegramUserId) {
    try {
        const userDoc = await db.collection('users').doc(telegramUserId.toString()).get();
        if (!userDoc.exists) return null;
        return userDoc.data().swiggyAuth?.token || null;
    } catch (error) {
        console.error('Error getting auth token:', error);
        return null;
    }
}

export async function saveConsumptionSchedule(telegramUserId, scheduleData, metadata = {}) {
    try {
        const profileRef = db.collection('grocery_profiles').doc(telegramUserId.toString());
        await profileRef.set({
            schedule: scheduleData.schedule || scheduleData,
            metadata: {
                ...metadata,
                completedAt: new Date().toISOString()
            }
        }, { merge: true });
        return true;
    } catch (error) {
        console.error('Error saving schedule to collection:', error);
        return false;
    }
}

export async function getConsumptionSchedule(telegramUserId) {
    try {
        const profileDoc = await db.collection('grocery_profiles').doc(telegramUserId.toString()).get();
        if (!profileDoc.exists) return null;
        return profileDoc.data() || null;
    } catch (error) {
        console.error('Error getting schedule from collection:', error);
        return null;
    }
}

export async function savePreferredAddress(telegramUserId, addressId) {
    try {
        const userRef = db.collection('users').doc(telegramUserId.toString());
        await userRef.set({
            preferredAddressId: addressId
        }, { merge: true });
        return true;
    } catch (error) {
        console.error('Error saving preferred address:', error);
        return false;
    }
}

export async function getPreferredAddress(telegramUserId) {
    try {
        const userDoc = await db.collection('users').doc(telegramUserId.toString()).get();
        if (!userDoc.exists) return null;
        return userDoc.data().preferredAddressId || null;
    } catch (error) {
        console.error('Error getting preferred address:', error);
        return null;
    }
}
