// useCardFormats.ts - Shared hook for credential formats across all components
// Fetches all 63 formats from the API

import { useState, useEffect } from 'react';

export interface CardFormat {
  id: string;
  name: string;
  category: string;
  bits: number;
  facilityBits?: number;
  cardBits?: number;
  maxFacility: number;
  maxCard: number;
  hasParity: boolean;
  parity?: 'std' | 'whole-even' | 'whole-odd';
  description: string;
  layout?: string;
  usage: string;
  popularity?: 'very-high' | 'high' | 'medium' | 'low';
  manufacturer?: string;
  aliases?: string[];
  equivalent?: string;
}

interface UseCardFormatsReturn {
  formats: CardFormat[];
  loading: boolean;
  error: string | null;
  getFormatById: (id: string) => CardFormat | undefined;
  getFormatByBits: (bits: number) => CardFormat | undefined;
  getFormatsByCategory: (category: string) => CardFormat[];
  getPopularFormats: () => CardFormat[];
  searchFormats: (query: string) => CardFormat[];
}

export function useCardFormats(apiUrl: string = 'http://192.168.1.202:3001'): UseCardFormatsReturn {
  const [formats, setFormats] = useState<CardFormat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const fetchFormats = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(`${apiUrl}/api/formats`);
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (isMounted && data.success && data.formats) {
          setFormats(data.formats);
        } else if (isMounted) {
          throw new Error('Invalid API response format');
        }
      } catch (err: any) {
        if (isMounted) {
          console.error('Failed to fetch card formats:', err);
          setError(err.message || 'Failed to fetch formats');
          
          // Fallback to basic formats
          setFormats([
            {
              id: 'w26',
              name: 'Wiegand 26 (H10301)',
              category: 'wiegand',
              bits: 26,
              facilityBits: 8,
              cardBits: 16,
              maxFacility: 255,
              maxCard: 65535,
              hasParity: true,
              parity: 'std',
              description: 'Standard 26-bit Wiegand',
              usage: 'Most common format',
              popularity: 'very-high'
            },
            {
              id: 'w34',
              name: 'Wiegand 34',
              category: 'wiegand',
              bits: 34,
              facilityBits: 16,
              cardBits: 16,
              maxFacility: 65535,
              maxCard: 65535,
              hasParity: true,
              parity: 'std',
              description: 'HID Corporate 1000 34-bit',
              usage: 'Large corporate',
              popularity: 'high'
            },
            {
              id: 'w37',
              name: 'Wiegand 37 (H10302)',
              category: 'wiegand',
              bits: 37,
              facilityBits: 16,
              cardBits: 19,
              maxFacility: 65535,
              maxCard: 524287,
              hasParity: true,
              parity: 'std',
              description: 'HID H10302 high-security',
              usage: 'High security',
              popularity: 'high'
            }
          ]);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchFormats();

    // Cleanup function
    return () => {
      isMounted = false;
    };
  }, [apiUrl]);

  // Helper function: Get format by ID
  const getFormatById = (id: string): CardFormat | undefined => {
    return formats.find(f => f.id === id || f.id === id.toLowerCase());
  };

  // Helper function: Get format by bit count
  const getFormatByBits = (bits: number): CardFormat | undefined => {
    return formats.find(f => f.bits === bits);
  };

  // Helper function: Get formats by category
  const getFormatsByCategory = (category: string): CardFormat[] => {
    return formats.filter(f => f.category === category);
  };

  // Helper function: Get popular formats
  const getPopularFormats = (): CardFormat[] => {
    return formats.filter(f => 
      f.popularity === 'very-high' || 
      f.popularity === 'high'
    );
  };

  // Helper function: Search formats
  const searchFormats = (query: string): CardFormat[] => {
    const q = query.toLowerCase();
    return formats.filter(f =>
      f.name.toLowerCase().includes(q) ||
      f.description.toLowerCase().includes(q) ||
      f.id.toLowerCase().includes(q) ||
      (f.manufacturer && f.manufacturer.toLowerCase().includes(q)) ||
      (f.category && f.category.toLowerCase().includes(q))
    );
  };

  return {
    formats,
    loading,
    error,
    getFormatById,
    getFormatByBits,
    getFormatsByCategory,
    getPopularFormats,
    searchFormats
  };
}

// Export helper to format display name
export function formatDisplayName(format: CardFormat): string {
  return `${format.name} (${format.bits}-bit)`;
}

// Export helper to validate facility code
export function isValidFacilityCode(format: CardFormat, facilityCode: number): boolean {
  if (format.facilityBits === 0) return true; // No facility code
  return facilityCode >= 0 && facilityCode <= format.maxFacility;
}

// Export helper to validate card number
export function isValidCardNumber(format: CardFormat, cardNumber: number): boolean {
  return cardNumber >= 0 && cardNumber <= format.maxCard;
}
