import React, { useId, useState } from 'react';
import { Play } from 'lucide-react';

const DOOR_KEYFRAMES = `
        @keyframes walkBob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
        }
        @keyframes leftArmSwing {
          0%, 100% { transform: rotate(20deg); }
          50% { transform: rotate(-20deg); }
        }
        @keyframes rightArmSwing {
          0%, 100% { transform: rotate(-20deg); }
          50% { transform: rotate(20deg); }
        }
        @keyframes leftLegWalk {
          0%, 100% { transform: rotate(-15deg); }
          50% { transform: rotate(15deg); }
        }
        @keyframes rightLegWalk {
          0%, 100% { transform: rotate(15deg); }
          50% { transform: rotate(-15deg); }
        }
        @keyframes headBob {
          0%, 100% { transform: rotate(-1deg); }
          50% { transform: rotate(1deg); }
        }
        @keyframes shadowPulse {
          0%, 100% { transform: scaleX(1); }
          50% { transform: scaleX(0.9); }
        }
        @keyframes rexBeamSweep {
          0% { transform: rotate(-18deg); opacity: 0.7; }
          50% { transform: rotate(18deg); opacity: 0.4; }
          100% { transform: rotate(-18deg); opacity: 0.7; }
        }
        @keyframes rexBeamPulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 0.15; }
        }
        @keyframes rexSensorBlink {
          0%, 90%, 100% { fill: rgb(var(--hv-success)); }
          95% { fill: rgb(var(--hv-success-text)); }
        }
        @keyframes rexGlow {
          0%, 100% { filter: drop-shadow(0 0 2px rgb(var(--hv-success))); }
          50% { filter: drop-shadow(0 0 5px rgb(var(--hv-success))); }
        }
        @keyframes beamParticle {
          0% { transform: translateY(0); opacity: 1; }
          100% { transform: translateY(50px); opacity: 0; }
        }
        @keyframes tieSway {
          0%, 100% { transform: rotate(-1deg); }
          50% { transform: rotate(1deg); }
        }
      `;

export interface DoorSceneProps {
  isLocked: boolean;
  isOpen: boolean;
  rexActive: boolean;
  enabled: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Text drawn on the door when not enabled (e.g. OFFLINE). */
  disabledLabel?: string;
  /** Override the SVG viewBox, e.g. to crop the empty margin around the frame. */
  viewBox?: string;
}

/**
 * The animated door scene on its own (hallway, wood door, REX beam, walking
 * person). Shared by the Doors page and the Stream View. SVG ids are made
 * unique per instance so several doors can be drawn on one page.
 */
export const DoorScene: React.FC<DoorSceneProps> = ({ isLocked, isOpen, rexActive, enabled, className, style, disabledLabel = 'DISABLED', viewBox = '0 0 200 260' }) => {
  const uid = 'ds' + useId().replace(/[^a-zA-Z0-9]/g, '') + '-';
  return (
    <>
      <style>{DOOR_KEYFRAMES}</style>
    <svg className={className} style={style} viewBox={viewBox} xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id={`${uid}rexBeamGradient`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgb(var(--hv-success))" stopOpacity="0.7" />
          <stop offset="100%" stopColor="rgb(var(--hv-success-text))" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${uid}hallwayFloor`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgb(var(--hv-text))" />
          <stop offset="100%" stopColor="rgb(var(--hv-text))" />
        </linearGradient>
        <linearGradient id={`${uid}hallwayCeiling`} x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="rgb(var(--hv-text))" />
          <stop offset="100%" stopColor="rgb(var(--hv-text))" />
        </linearGradient>
        <linearGradient id={`${uid}woodGrain`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgb(var(--hv-brand-tint-strong))" />
          <stop offset="50%" stopColor="rgb(var(--hv-brand-hover))" />
          <stop offset="100%" stopColor="rgb(var(--hv-brand-tint-strong))" />
        </linearGradient>
        <linearGradient id={`${uid}woodPanel`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="rgb(var(--hv-brand-hover))" />
          <stop offset="100%" stopColor="rgb(var(--hv-brand-tint-strong))" />
        </linearGradient>
        <linearGradient id={`${uid}suitGradient`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="rgb(var(--hv-widget))" />
          <stop offset="100%" stopColor="rgb(var(--hv-line))" />
        </linearGradient>
        <linearGradient id={`${uid}doorFrame`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgb(var(--hv-line-strong))" />
          <stop offset="100%" stopColor="rgb(var(--hv-line-strong))" />
        </linearGradient>
        <filter id={`${uid}lightGlow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
          <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      
      {/* Door Frame */}
      <rect x="25" y="18" width="150" height="230" fill={`url(#${uid}doorFrame)`} rx="2" />
      <rect x="30" y="23" width="140" height="220" fill="transparent" />
      
      {/* 3D Hallway */}
      <g>
        <clipPath id={`${uid}doorClip`}><rect x="32" y="25" width="136" height="216" /></clipPath>
        <g clipPath={`url(#${uid}doorClip)`}>
          <rect x="70" y="60" width="60" height="140" fill="rgb(var(--hv-text))" />
          <polygon points="32,25 168,25 130,60 70,60" fill={`url(#${uid}hallwayCeiling)`} />
          <polygon points="32,241 168,241 130,200 70,200" fill={`url(#${uid}hallwayFloor)`} />
          <polygon points="32,25 70,60 70,200 32,241" fill="rgb(var(--hv-text))" />
          <polygon points="168,25 130,60 130,200 168,241" fill="rgb(var(--hv-text))" />
          <rect x="80" y="32" width="40" height="8" fill="rgb(var(--hv-text))" filter={`url(#${uid}lightGlow)`} />
          <rect x="88" y="48" width="24" height="5" fill="rgb(var(--hv-text))" filter={`url(#${uid}lightGlow)`} />
          <line x1="32" y1="145" x2="70" y2="135" stroke="rgb(var(--hv-text))" strokeWidth="1.5" />
          <line x1="168" y1="145" x2="130" y2="135" stroke="rgb(var(--hv-text))" strokeWidth="1.5" />
          <line x1="70" y1="135" x2="130" y2="135" stroke="rgb(var(--hv-text))" strokeWidth="1.5" />
          <line x1="32" y1="241" x2="70" y2="200" stroke="rgb(var(--hv-text-2))" strokeWidth="2" />
          <line x1="168" y1="241" x2="130" y2="200" stroke="rgb(var(--hv-text-2))" strokeWidth="2" />
          <line x1="70" y1="200" x2="130" y2="200" stroke="rgb(var(--hv-text-2))" strokeWidth="2" />
          <polygon points="40,85 62,95 62,175 40,190" fill="rgb(var(--hv-text-3))" stroke="rgb(var(--hv-line-strong))" strokeWidth="1" />
          <circle cx="60" cy="138" r="2" fill="rgb(var(--hv-warning))" />
          <polygon points="160,85 138,95 138,175 160,190" fill="rgb(var(--hv-text-3))" stroke="rgb(var(--hv-line-strong))" strokeWidth="1" />
          <circle cx="140" cy="138" r="2" fill="rgb(var(--hv-warning))" />
          <rect x="85" y="95" width="30" height="105" fill="rgb(var(--hv-text-3))" stroke="rgb(var(--hv-line-strong))" strokeWidth="1" />
          <circle cx="110" cy="150" r="1.5" fill="rgb(var(--hv-warning))" />
          <rect x="90" y="68" width="20" height="8" fill="rgb(var(--hv-error-hover))" rx="1" />
          <text x="100" y="75" textAnchor="middle" fill="white" fontSize="5" fontWeight="bold">EXIT</text>
        </g>
      </g>
      
      {/* REX Sensor */}
      {enabled && (
        <g>
          <rect x="90" y="3" width="20" height="5" fill="rgb(var(--hv-modal))" rx="1" />
          <g style={rexActive ? { animation: 'rexGlow 1s ease-in-out infinite' } : {}}>
            <ellipse cx="100" cy="12" rx="14" ry="7" fill={rexActive ? "rgb(var(--hv-success-tint-strong))" : "rgb(var(--hv-line))"} stroke={rexActive ? "rgb(var(--hv-success))" : "rgb(var(--hv-modal))"} strokeWidth="1.5" />
            <ellipse cx="100" cy="10" rx="10" ry="5" fill={rexActive ? "rgb(var(--hv-success-tint-strong))" : "rgb(var(--hv-widget))"} />
            <ellipse cx="100" cy="13" rx="5" ry="3" fill={rexActive ? "rgb(var(--hv-success))" : "rgb(var(--hv-line-strong))"} style={rexActive ? { animation: 'rexSensorBlink 2s ease-in-out infinite' } : {}} />
            <circle cx="100" cy="6" r="2" fill={rexActive ? "rgb(var(--hv-success-text))" : "rgb(var(--hv-line-strong))"} style={rexActive ? { animation: 'rexSensorBlink 0.5s ease-in-out infinite' } : {}} />
          </g>
          <text x="100" y="16" textAnchor="middle" fill={rexActive ? "rgb(var(--hv-success-text))" : "rgb(var(--hv-text-3))"} fontSize="4" fontWeight="bold">REX</text>
          {rexActive && (
            <g>
              <g style={{ animation: 'rexBeamSweep 2s ease-in-out infinite', transformOrigin: '92px 20px' }}>
                <polygon points="92,20 50,248 70,248" fill={`url(#${uid}rexBeamGradient)`} opacity="0.5" />
              </g>
              <g style={{ animation: 'rexBeamSweep 2s ease-in-out infinite reverse', transformOrigin: '108px 20px' }}>
                <polygon points="108,20 130,248 150,248" fill={`url(#${uid}rexBeamGradient)`} opacity="0.5" />
              </g>
              <polygon points="96,20 80,248 120,248 104,20" fill={`url(#${uid}rexBeamGradient)`} style={{ animation: 'rexBeamPulse 1s ease-in-out infinite' }} opacity="0.4" />
              <circle cx="96" cy="55" r="1.5" fill="rgb(var(--hv-success-text))" style={{ animation: 'beamParticle 1.5s linear infinite' }} />
              <circle cx="104" cy="75" r="1.5" fill="rgb(var(--hv-success-text))" style={{ animation: 'beamParticle 1.5s linear infinite 0.4s' }} />
              <circle cx="100" cy="40" r="1.5" fill="rgb(var(--hv-success-text))" style={{ animation: 'beamParticle 1.5s linear infinite 0.8s' }} />
            </g>
          )}
        </g>
      )}
      
      {enabled ? (
        <>
          {isOpen ? (
            <>
              {/* Open Door */}
              <g>
                <polygon points="30,25 30,243 48,238 48,30" fill="rgb(var(--hv-brand-tint-strong))" stroke="rgb(var(--hv-line-strong))" strokeWidth="1.5" />
                <rect x="46" y="30" width="5" height="208" fill="rgb(var(--hv-line-strong))" />
              </g>
              
              {/* Walking Person */}
              <g>
                <ellipse cx="100" cy="244" rx="12" ry="3" fill="rgb(var(--hv-surface))" opacity="0.5" style={{ animation: 'shadowPulse 0.6s ease-in-out infinite', transformOrigin: '100px 244px' }} />
                <g style={{ animation: 'walkBob 0.6s ease-in-out infinite', transformOrigin: '100px 210px' }}>
                  {/* Legs */}
                  <g style={{ animation: 'leftLegWalk 0.6s ease-in-out infinite', transformOrigin: '96px 208px' }}>
                    <rect x="93" y="208" width="6" height="32" fill="rgb(var(--hv-widget))" rx="2" />
                    <ellipse cx="96" cy="241" rx="6" ry="3" fill="rgb(var(--hv-widget-panel))" />
                  </g>
                  <g style={{ animation: 'rightLegWalk 0.6s ease-in-out infinite', transformOrigin: '104px 208px' }}>
                    <rect x="101" y="208" width="6" height="32" fill="rgb(var(--hv-widget))" rx="2" />
                    <ellipse cx="104" cy="241" rx="6" ry="3" fill="rgb(var(--hv-widget-panel))" />
                  </g>
                  {/* Torso */}
                  <rect x="91" y="172" width="18" height="38" fill="rgb(var(--hv-text))" rx="2" />
                  <path d="M 88 175 L 88 208 L 96 208 L 96 202 L 104 202 L 104 208 L 112 208 L 112 175 L 104 178 L 100 175 L 96 178 Z" fill={`url(#${uid}suitGradient)`} />
                  <path d="M 96 178 L 100 188 L 100 175 Z" fill="rgb(var(--hv-widget-panel))" />
                  <path d="M 104 178 L 100 188 L 100 175 Z" fill="rgb(var(--hv-widget-panel))" />
                  <g style={{ animation: 'tieSway 0.6s ease-in-out infinite', transformOrigin: '100px 178px' }}>
                    <polygon points="98,176 102,176 101,202 100,205 99,202" fill="rgb(var(--hv-error-hover))" />
                    <polygon points="98,174 102,174 103,177 97,177" fill="rgb(var(--hv-error-tint-strong))" />
                  </g>
                  <polygon points="96,172 100,176 104,172 102,172 100,174 98,172" fill="rgb(var(--hv-text))" />
                  <ellipse cx="100" cy="175" rx="14" ry="5" fill="rgb(var(--hv-line))" />
                  {/* Arms */}
                  <g style={{ animation: 'rightArmSwing 0.6s ease-in-out infinite', transformOrigin: '88px 176px' }}>
                    <rect x="74" y="173" width="16" height="6" fill="rgb(var(--hv-line))" rx="2" />
                    <rect x="72" y="178" width="6" height="18" fill="rgb(var(--hv-line))" rx="2" />
                    <rect x="72" y="194" width="6" height="2" fill="rgb(var(--hv-text))" rx="1" />
                    <circle cx="75" cy="200" r="4" fill="rgb(var(--hv-brand-text))" />
                  </g>
                  <g style={{ animation: 'leftArmSwing 0.6s ease-in-out infinite', transformOrigin: '112px 176px' }}>
                    <rect x="110" y="173" width="16" height="6" fill="rgb(var(--hv-line))" rx="2" />
                    <rect x="122" y="178" width="6" height="18" fill="rgb(var(--hv-line))" rx="2" />
                    <rect x="122" y="194" width="6" height="2" fill="rgb(var(--hv-text))" rx="1" />
                    <circle cx="125" cy="200" r="4" fill="rgb(var(--hv-brand-text))" />
                  </g>
                  {/* Head */}
                  <g style={{ animation: 'headBob 0.6s ease-in-out infinite', transformOrigin: '100px 152px' }}>
                    <rect x="97" y="163" width="6" height="10" fill="rgb(var(--hv-brand-text))" />
                    <ellipse cx="100" cy="150" rx="12" ry="15" fill="rgb(var(--hv-brand-text))" />
                    <ellipse cx="100" cy="138" rx="10" ry="7" fill="rgb(var(--hv-popup-panel))" />
                    <path d="M 89 143 Q 89 134 100 134 Q 111 134 111 143" fill="rgb(var(--hv-popup-panel))" />
                    <ellipse cx="89" cy="150" rx="2.5" ry="4" fill="rgb(var(--hv-brand-text))" />
                    <ellipse cx="111" cy="150" rx="2.5" ry="4" fill="rgb(var(--hv-brand-text))" />
                    <ellipse cx="95" cy="148" rx="1.5" ry="2" fill="rgb(var(--hv-widget))" />
                    <ellipse cx="105" cy="148" rx="1.5" ry="2" fill="rgb(var(--hv-widget))" />
                    <circle cx="95.5" cy="147.5" r="0.5" fill="white" />
                    <circle cx="105.5" cy="147.5" r="0.5" fill="white" />
                    <path d="M 93 144 Q 95 143 97 144" stroke="rgb(var(--hv-popup-panel))" strokeWidth="0.75" fill="none" />
                    <path d="M 103 144 Q 105 143 107 144" stroke="rgb(var(--hv-popup-panel))" strokeWidth="0.75" fill="none" />
                    <path d="M 95 158 Q 100 163 105 158" stroke="rgb(var(--hv-error-hover))" strokeWidth="1.2" fill="none" strokeLinecap="round" />
                    {rexActive && <ellipse cx="100" cy="150" rx="15" ry="18" fill="none" stroke="rgb(var(--hv-success))" strokeWidth="1.5" opacity="0.5" style={{ animation: 'rexBeamPulse 0.5s ease-in-out infinite' }} />}
                  </g>
                </g>
              </g>
            </>
          ) : (
            <>
              {/* Closed Door */}
              <rect x="32" y="25" width="136" height="218" fill={`url(#${uid}woodGrain)`} stroke="rgb(var(--hv-line-strong))" strokeWidth="2" rx="1" />
              <line x1="55" y1="25" x2="55" y2="243" stroke="rgb(var(--hv-brand-tint-strong))" strokeWidth="0.5" opacity="0.3" />
              <line x1="85" y1="25" x2="85" y2="243" stroke="rgb(var(--hv-brand-tint-strong))" strokeWidth="0.5" opacity="0.2" />
              <line x1="115" y1="25" x2="115" y2="243" stroke="rgb(var(--hv-brand-tint-strong))" strokeWidth="0.5" opacity="0.2" />
              <line x1="145" y1="25" x2="145" y2="243" stroke="rgb(var(--hv-brand-tint-strong))" strokeWidth="0.5" opacity="0.3" />
              <rect x="42" y="38" width="50" height="80" fill={`url(#${uid}woodPanel)`} stroke="rgb(var(--hv-line-strong))" strokeWidth="1.5" rx="1" />
              <rect x="108" y="38" width="50" height="80" fill={`url(#${uid}woodPanel)`} stroke="rgb(var(--hv-line-strong))" strokeWidth="1.5" rx="1" />
              <rect x="42" y="132" width="50" height="80" fill={`url(#${uid}woodPanel)`} stroke="rgb(var(--hv-line-strong))" strokeWidth="1.5" rx="1" />
              <rect x="108" y="132" width="50" height="80" fill={`url(#${uid}woodPanel)`} stroke="rgb(var(--hv-line-strong))" strokeWidth="1.5" rx="1" />
              <rect x="45" y="41" width="44" height="74" fill="none" stroke="rgb(var(--hv-brand-tint-strong))" strokeWidth="0.5" />
              <rect x="111" y="41" width="44" height="74" fill="none" stroke="rgb(var(--hv-brand-tint-strong))" strokeWidth="0.5" />
              <rect x="45" y="135" width="44" height="74" fill="none" stroke="rgb(var(--hv-brand-tint-strong))" strokeWidth="0.5" />
              <rect x="111" y="135" width="44" height="74" fill="none" stroke="rgb(var(--hv-brand-tint-strong))" strokeWidth="0.5" />
              <ellipse cx="152" cy="135" rx="8" ry="8" fill="rgb(var(--hv-widget))" stroke="rgb(var(--hv-modal))" strokeWidth="1" />
              <circle cx="152" cy="135" r="5" fill={isLocked ? "rgb(var(--hv-error))" : "rgb(var(--hv-success))"} stroke={isLocked ? "rgb(var(--hv-error-hover))" : "rgb(var(--hv-success-strong))"} strokeWidth="1.5" className={!isLocked ? "animate-pulse" : ""} />
              <rect x="136" y="133.5" width="16" height="3" fill={isLocked ? "rgb(var(--hv-error))" : "rgb(var(--hv-success))"} rx="1.5" />
              <circle cx="152" cy="115" r="7" fill="rgb(var(--hv-widget))" stroke="rgb(var(--hv-modal))" strokeWidth="0.75" />
              {isLocked ? (
                <g>
                  <path d="M 149.5 115 L 149.5 113 Q 149.5 110.5 152 110.5 Q 154.5 110.5 154.5 113 L 154.5 115" fill="none" stroke="rgb(var(--hv-error))" strokeWidth="1.2" />
                  <rect x="148.5" y="114.5" width="7" height="5" rx="1" fill="rgb(var(--hv-error))" />
                </g>
              ) : (
                <text x="152" y="118" textAnchor="middle" fill="rgb(var(--hv-success))" fontSize="7">✓</text>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <rect x="32" y="25" width="136" height="218" fill="rgb(var(--hv-line))" stroke="rgb(var(--hv-modal))" strokeWidth="2" opacity="0.5" rx="1" />
          <text x="100" y="140" textAnchor="middle" fill="rgb(var(--hv-line-strong))" fontSize="12" fontWeight="bold">{disabledLabel}</text>
        </>
      )}
    </svg>
    </>
  );
};

interface DoorAnimationProps {
  doorName: string;
  isLocked: boolean;
  isOpen: boolean;
  rexActive: boolean;
  enabled: boolean;
  onCustomEvent?: (eventNumber: number) => void;
  customEventNames?: string[];
}

const DoorAnimation: React.FC<DoorAnimationProps> = ({
  doorName,
  isLocked,
  isOpen,
  rexActive,
  enabled,
  onCustomEvent,
  customEventNames = ['Custom Event 1', 'Custom Event 2', 'Custom Event 3', 'Custom Event 4', 'Custom Event 5', 'Custom Event 6']
}) => {
  const [activeEventTab, setActiveEventTab] = useState(1);

  return (
    <div className="relative w-full">
      <div className="flex gap-3">
        {/* Quick Events */}
        <div className="w-28 flex-shrink-0 space-y-1">
          {[1, 2, 3, 4, 5, 6].map((num) => (
            <button
              key={num}
              onClick={() => {
                setActiveEventTab(num);
                onCustomEvent?.(num);
              }}
              disabled={!enabled}
              className={`w-full px-2 py-1.5 rounded border transition-all disabled:opacity-30 disabled:cursor-not-allowed text-left ${
                activeEventTab === num && enabled
                  ? 'bg-cyan-600/20 border-cyan-500/50 text-cyan-400'
                  : enabled
                  ? 'bg-transparent border-slate-700/50 text-slate-400 hover:bg-slate-800/30'
                  : 'bg-transparent border-slate-800/30 text-slate-600'
              }`}
            >
              <div className="flex items-center gap-1">
                <Play size={10} className={activeEventTab === num ? 'text-cyan-400' : 'text-slate-500'} fill={activeEventTab === num ? 'currentColor' : 'none'} />
                <span className="text-[10px] font-medium">Event {num}</span>
              </div>
              <div className="text-[8px] text-slate-500 truncate pl-3.5">
                {customEventNames[num - 1] || `Custom Event ${num}`}
              </div>
            </button>
          ))}
        </div>

        {/* Door Animation */}
        <div className="flex-1 relative flex items-center justify-center">
          <DoorScene
            isLocked={isLocked}
            isOpen={isOpen}
            rexActive={rexActive}
            enabled={enabled}
            className="w-full h-full max-h-[400px]"
          />
          
          {/* Labels */}
          <div className="absolute top-1 left-1">
            <div className="text-sm font-semibold text-hv-text">{doorName}</div>
            <div className="flex items-center gap-1 mt-0.5">
              {enabled ? (
                isOpen ? (
                  <><span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" /><span className="text-[10px] text-blue-400">OPEN</span></>
                ) : isLocked ? (
                  <><span className="w-1.5 h-1.5 rounded-full bg-red-500" /><span className="text-[10px] text-red-400">LOCKED</span></>
                ) : (
                  <><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /><span className="text-[10px] text-green-400">UNLOCKED</span></>
                )
              ) : <span className="text-[10px] text-slate-500">DISABLED</span>}
            </div>
          </div>

          <div className="absolute top-1 right-1 text-right">
            <div className="text-[8px] text-slate-500 uppercase">Active Event</div>
            <div className="text-xs text-hv-text font-semibold">Event {activeEventTab}</div>
          </div>

          <div className="absolute bottom-1 right-1">
            {enabled && isLocked && !isOpen && <div className="bg-red-500/20 px-1.5 py-0.5 rounded text-[9px] font-semibold text-red-400 border border-red-500/30">Secured</div>}
            {enabled && !isLocked && !isOpen && <div className="bg-green-500/20 px-1.5 py-0.5 rounded text-[9px] font-semibold text-green-400 border border-green-500/30">Secured</div>}
            {enabled && isOpen && <div className="bg-blue-500/20 px-1.5 py-0.5 rounded text-[9px] font-semibold text-blue-400 border border-blue-500/30">ACCESS GRANTED</div>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DoorAnimation;
